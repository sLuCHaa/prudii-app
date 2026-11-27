use std::collections::{HashMap, HashSet};
use std::path::Path;

use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::OptionalExtension;
use tokio::io::{AsyncRead, AsyncWrite};

use super::store::{self, DeleteMode, DeletePolicy, UidlRow};
use super::{Pop3Client, Pop3Error, Pop3Security, MAX_MESSAGE_BYTES};
use crate::db::Database;
use crate::imap::InsertOutcome;
use crate::models::Account;

// Same text form as SQLite's datetime('now'), the column default.
const FETCHED_AT_FORMAT: &str = "%Y-%m-%d %H:%M:%S";

#[derive(Debug, Default)]
pub struct Pop3SyncReport {
    pub new_mail_ids: Vec<String>,
    pub deleted_on_server: u32,
    pub skipped_too_large: u32,
}

pub async fn sync_pop3_account(
    db: &Database,
    data_dir: &Path,
    account: &Account,
    password: &str,
) -> Result<Pop3SyncReport, Pop3Error> {
    let security: Pop3Security = account.incoming_security.parse()?;
    let port = u16::try_from(account.imap_port)
        .map_err(|_| Pop3Error::Io(format!("invalid port {}", account.imap_port)))?;
    let mut client = super::connect(&account.imap_host, port, security).await?;
    client.capa().await?;
    client.login(&account.email, password).await?;
    sync_with_client(client, db, data_dir, account).await
}

/// Errors return without QUIT on purpose: the server then discards every DELE of the session.
pub(crate) async fn sync_with_client<S: AsyncRead + AsyncWrite + Unpin>(
    mut client: Pop3Client<S>,
    db: &Database,
    data_dir: &Path,
    account: &Account,
) -> Result<Pop3SyncReport, Pop3Error> {
    let listing = client.uidl_all().await?;
    let sizes: HashMap<u32, u64> = client.list_all().await?.into_iter().collect();
    let inbox = inbox_folder_id(db, &account.id)?;

    let server_uidls: HashSet<String> = listing.iter().map(|(_, uidl)| uidl.clone()).collect();
    let mut numbers: HashMap<&str, Option<u32>> = HashMap::new();
    for (msg, uidl) in &listing {
        numbers
            .entry(uidl.as_str())
            .and_modify(|n| *n = None)
            .or_insert(Some(*msg));
    }

    let known: HashSet<String> = load_rows(db, &account.id)?.into_iter().map(|r| r.uidl).collect();
    let mut fresh: Vec<(u32, &str)> = listing
        .iter()
        .filter(|(_, uidl)| !known.contains(uidl))
        .map(|(msg, uidl)| (*msg, uidl.as_str()))
        .collect();
    fresh.sort_by_key(|entry| std::cmp::Reverse(entry.0));

    let mut report = Pop3SyncReport::default();
    let mut seen = HashSet::new();
    for (msg, uidl) in fresh {
        if !seen.insert(uidl) {
            continue;
        }
        if let Some(&size) = sizes.get(&msg).filter(|&&size| size > MAX_MESSAGE_BYTES) {
            skip_too_large(&mut report, account, uidl, size);
            continue;
        }
        let raw = match client.retr(msg, MAX_MESSAGE_BYTES).await {
            Ok(raw) => raw,
            Err(Pop3Error::TooLarge(size)) => {
                skip_too_large(&mut report, account, uidl, size);
                continue;
            }
            Err(e) => return Err(e),
        };
        if let Some(mail_id) = store_fetched(db, data_dir, &account.id, &inbox, uidl, &raw).await? {
            report.new_mail_ids.push(mail_id);
        }
    }

    prune_vanished(db, &account.id, &server_uidls)?;

    let rows = load_rows(db, &account.id)?;
    let mail_ids: HashMap<&str, &str> = rows
        .iter()
        .filter_map(|r| r.mail_id.as_deref().map(|m| (r.uidl.as_str(), m)))
        .collect();
    let mut targets: Vec<(u32, String)> = Vec::new();
    for uidl in store::plan_deletions(Utc::now(), &delete_policy(account), &rows, &server_uidls) {
        match numbers.get(uidl.as_str()) {
            Some(Some(msg)) => targets.push((*msg, uidl)),
            _ => log::warn!("POP3 {}: no unique message number for a planned delete, kept on server", account.id),
        }
    }
    targets.sort();

    let mut deleted = Vec::new();
    for (msg, uidl) in targets {
        let Some(mail_id) = mail_ids.get(uidl.as_str()) else { continue };
        if !store::has_source(data_dir, mail_id) {
            log::warn!("POP3 {}: raw source of mail {} missing, kept on server", account.id, mail_id);
            continue;
        }
        match client.dele(msg).await? {
            Ok(()) => deleted.push(uidl),
            Err(text) => log::warn!("POP3 {}: DELE {} refused: {}", account.id, msg, text),
        }
    }

    if let Err(e) = client.quit().await {
        log::warn!("POP3 {}: QUIT failed, server deletes are retried next run: {}", account.id, e);
        return Ok(report);
    }
    match mark_server_deleted(db, &account.id, &deleted) {
        Ok(marked) => report.deleted_on_server = marked,
        Err(e) => log::warn!("POP3 {}: could not mark server deletes: {}", account.id, e),
    }
    Ok(report)
}

fn skip_too_large(report: &mut Pop3SyncReport, account: &Account, uidl: &str, size: u64) {
    log::warn!("POP3 {}: message {} has {} bytes, left on the server", account.id, uidl, size);
    report.skipped_too_large += 1;
}

/// Returns the id of a newly inserted mail; None when the UIDL maps to an existing mail or nothing was stored.
async fn store_fetched(
    db: &Database,
    data_dir: &Path,
    account_id: &str,
    inbox: &str,
    uidl: &str,
    raw: &[u8],
) -> Result<Option<String>, Pop3Error> {
    let mail_id = uuid::Uuid::new_v4().to_string();
    store::write_source(data_dir, &mail_id, raw).map_err(|e| Pop3Error::Storage(e.to_string()))?;
    let outcome = match crate::imap::insert_local_mail(db, account_id, inbox, &mail_id, raw, false) {
        Ok(outcome) => outcome,
        Err(e) => {
            remove_source(data_dir, &mail_id);
            return Err(Pop3Error::Database(e.to_string()));
        }
    };
    match outcome {
        InsertOutcome::Inserted(id) => {
            record_uidl(db, account_id, uidl, Some(&id))?;
            if let Err(e) = crate::imap::store_body_and_attachments(db, &id, raw).await {
                log::warn!("POP3 {}: storing body and attachments of {} failed: {}", account_id, id, e);
            }
            Ok(Some(id))
        }
        InsertOutcome::Existing(existing) => {
            let mapped = if store::has_source(data_dir, &existing) {
                remove_source(data_dir, &mail_id);
                let same = store::read_source(data_dir, &existing).is_ok_and(|stored| stored == raw);
                if !same {
                    log::warn!(
                        "POP3 {}: message {} reuses the Message-ID of mail {}, left on the server",
                        account_id, uidl, existing
                    );
                }
                same
            } else {
                match store::move_source(data_dir, &mail_id, &existing) {
                    Ok(()) => true,
                    Err(e) => {
                        log::warn!("POP3 {}: could not attach the raw source to mail {}: {}", account_id, existing, e);
                        remove_source(data_dir, &mail_id);
                        false
                    }
                }
            };
            record_uidl(db, account_id, uidl, mapped.then_some(existing.as_str()))?;
            Ok(None)
        }
        InsertOutcome::NotStored => {
            log::warn!("POP3 {}: message {} could not be stored, left on the server", account_id, uidl);
            remove_source(data_dir, &mail_id);
            Ok(None)
        }
    }
}

fn remove_source(data_dir: &Path, mail_id: &str) {
    let _ = std::fs::remove_file(store::source_path(data_dir, mail_id));
}

fn db_error(e: rusqlite::Error) -> Pop3Error {
    Pop3Error::Database(e.to_string())
}

fn inbox_folder_id(db: &Database, account_id: &str) -> Result<String, Pop3Error> {
    db.lock_db()
        .query_row(
            "SELECT id FROM folders WHERE account_id = ?1 AND folder_type = 'inbox' ORDER BY rowid LIMIT 1",
            [account_id],
            |r| r.get(0),
        )
        .optional()
        .map_err(db_error)?
        .ok_or(Pop3Error::NoInbox)
}

/// A row without mail_id keeps the message known but never deletable.
fn record_uidl(db: &Database, account_id: &str, uidl: &str, mail_id: Option<&str>) -> Result<(), Pop3Error> {
    let fetched_at = Utc::now().format(FETCHED_AT_FORMAT).to_string();
    db.lock_db()
        .execute(
            "INSERT INTO pop3_uidls (account_id, uidl, mail_id, fetched_at, state) VALUES (?1, ?2, ?3, ?4, 'stored')",
            rusqlite::params![account_id, uidl, mail_id, fetched_at],
        )
        .map(drop)
        .map_err(db_error)
}

fn load_rows(db: &Database, account_id: &str) -> Result<Vec<UidlRow>, Pop3Error> {
    let now = Utc::now();
    let conn = db.lock_db();
    let mut stmt = conn
        .prepare("SELECT uidl, mail_id, fetched_at, state, local_deleted_at FROM pop3_uidls WHERE account_id = ?1")
        .map_err(db_error)?;
    let rows = stmt
        .query_map([account_id], |r| {
            let fetched_at: String = r.get(2)?;
            Ok(UidlRow {
                uidl: r.get(0)?,
                mail_id: r.get(1)?,
                // An unreadable timestamp never counts as old.
                fetched_at: parse_fetched_at(&fetched_at).unwrap_or(now),
                state: r.get(3)?,
                local_deleted_at: r.get(4)?,
            })
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(rows)
}

fn parse_fetched_at(value: &str) -> Option<DateTime<Utc>> {
    NaiveDateTime::parse_from_str(value, FETCHED_AT_FORMAT)
        .map(|t| t.and_utc())
        .or_else(|_| DateTime::parse_from_rfc3339(value).map(|t| t.with_timezone(&Utc)))
        .ok()
}

fn delete_policy(account: &Account) -> DeletePolicy {
    let mode = match account.pop3_delete_mode.as_str() {
        "after_fetch" => DeleteMode::AfterFetch,
        "after_days" => DeleteMode::AfterDays(account.pop3_delete_after_days.max(0)),
        _ => DeleteMode::Keep,
    };
    DeletePolicy { mode, with_local: account.pop3_delete_with_local }
}

fn prune_vanished(db: &Database, account_id: &str, server_uidls: &HashSet<String>) -> Result<(), Pop3Error> {
    let vanished: Vec<String> = load_rows(db, account_id)?
        .into_iter()
        .map(|r| r.uidl)
        .filter(|uidl| !server_uidls.contains(uidl))
        .collect();
    update_each(db, account_id, &vanished, "DELETE FROM pop3_uidls WHERE account_id = ?1 AND uidl = ?2").map(drop)
}

fn mark_server_deleted(db: &Database, account_id: &str, uidls: &[String]) -> Result<u32, Pop3Error> {
    update_each(
        db,
        account_id,
        uidls,
        "UPDATE pop3_uidls SET state = 'server_deleted' WHERE account_id = ?1 AND uidl = ?2",
    )
}

/// Returns the number of changed rows.
fn update_each(db: &Database, account_id: &str, uidls: &[String], sql: &str) -> Result<u32, Pop3Error> {
    if uidls.is_empty() {
        return Ok(0);
    }
    let mut conn = db.lock_db();
    let tx = conn.transaction().map_err(db_error)?;
    let mut changed = 0;
    for uidl in uidls {
        changed += tx.execute(sql, rusqlite::params![account_id, uidl]).map_err(db_error)?;
    }
    tx.commit().map_err(db_error)?;
    Ok(u32::try_from(changed).unwrap_or(u32::MAX))
}

#[cfg(test)]
mod tests {
    use std::path::PathBuf;

    use super::*;
    use crate::pop3::test_server::scripted;
    use crate::test_support::{seed_account, seed_folder, temp_db};

    const GREETING: (&str, &str) = ("", "+OK pop.studio-halde.example ready\r\n");
    const QUIT: (&str, &str) = ("QUIT", "+OK bye\r\n");

    struct Env {
        db: Database,
        dir: PathBuf,
        account: Account,
        inbox: String,
    }

    impl Drop for Env {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn env(mode: &str) -> Env {
        let db = temp_db();
        let (account_id, inbox) = {
            let conn = db.lock_db();
            let account_id = seed_account(&conn, "anna@studio-halde.example");
            let inbox = seed_folder(&conn, &account_id, "inbox");
            (account_id, inbox)
        };
        let dir = std::env::temp_dir().join(format!("prudii-pop3-sync-{}", uuid::Uuid::new_v4()));
        Env { db, dir, account: account(&account_id, mode), inbox }
    }

    fn account(id: &str, mode: &str) -> Account {
        Account {
            id: id.into(),
            email: "anna@studio-halde.example".into(),
            display_name: "Anna Weber".into(),
            provider: "imap".into(),
            color: "#3b82f6".into(),
            imap_host: "pop.studio-halde.example".into(),
            imap_port: 995,
            smtp_host: "smtp.studio-halde.example".into(),
            smtp_port: 465,
            smtp_security: "ssl".into(),
            auth_type: "password".into(),
            signature_id: None,
            signature_html: String::new(),
            signature_text: String::new(),
            signature_on_compose: true,
            signature_on_reply: true,
            sync_interval_minutes: 0,
            load_external_images: "always".into(),
            created_at: String::new(),
            updated_at: String::new(),
            incoming_protocol: "pop3".into(),
            incoming_security: "ssl".into(),
            pop3_delete_mode: mode.into(),
            pop3_delete_after_days: 14,
            pop3_delete_with_local: false,
        }
    }

    fn leak(text: String) -> &'static str {
        Box::leak(text.into_boxed_str())
    }

    fn mail(id: &str, subject: &str) -> String {
        format!(
            "From: Anna Weber <anna@studio-halde.example>\r\nTo: Studio Halde <info@studio-halde.example>\r\nSubject: {subject}\r\nMessage-ID: <{id}@studio-halde.example>\r\nDate: Fri, 27 Nov 2026 10:00:00 +0100\r\n\r\nHallo aus dem Studio.\r\n"
        )
    }

    fn retr(msg: u32, raw: &str) -> (&'static str, &'static str) {
        (leak(format!("RETR {msg}")), leak(format!("+OK\r\n{raw}.\r\n")))
    }

    fn uidl(entries: &[(u32, &str)]) -> (&'static str, &'static str) {
        let lines: String = entries.iter().map(|(n, u)| format!("{n} {u}\r\n")).collect();
        ("UIDL", leak(format!("+OK\r\n{lines}.\r\n")))
    }

    fn list(entries: &[(u32, u64)]) -> (&'static str, &'static str) {
        let lines: String = entries.iter().map(|(n, s)| format!("{n} {s}\r\n")).collect();
        ("LIST", leak(format!("+OK\r\n{lines}.\r\n")))
    }

    fn dele(msg: u32) -> (&'static str, &'static str) {
        (leak(format!("DELE {msg}")), "+OK deleted\r\n")
    }

    async fn run(t: &Env, mut script: Vec<(&'static str, &'static str)>) -> Result<Pop3SyncReport, Pop3Error> {
        script.insert(0, GREETING);
        let (stream, server) = scripted(script);
        let client = Pop3Client::from_stream(stream).await.expect("greeting");
        let result = sync_with_client(client, &t.db, &t.dir, &t.account).await;
        server.await.expect("server script");
        result
    }

    fn uidl_rows(t: &Env) -> Vec<(String, Option<String>, String)> {
        let conn = t.db.lock_db();
        let mut stmt = conn
            .prepare("SELECT uidl, mail_id, state FROM pop3_uidls WHERE account_id = ?1 ORDER BY uidl")
            .unwrap();
        stmt.query_map([&t.account.id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn inbox_mails(t: &Env) -> Vec<(String, String, bool, String)> {
        let conn = t.db.lock_db();
        let mut stmt = conn
            .prepare("SELECT id, subject, is_read, COALESCE(body_text, '') FROM mails WHERE folder_id = ?1 ORDER BY subject")
            .unwrap();
        stmt.query_map([&t.inbox], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))
            .unwrap()
            .map(Result::unwrap)
            .collect()
    }

    fn source_files(t: &Env) -> usize {
        std::fs::read_dir(t.dir.join("mail_sources")).map_or(0, |entries| entries.count())
    }

    fn mail_of(t: &Env, uidl: &str) -> String {
        uidl_rows(t).into_iter().find(|r| r.0 == uidl).and_then(|r| r.1).unwrap()
    }

    fn set_column(t: &Env, uidl: &str, sql: &str) {
        let conn = t.db.lock_db();
        conn.execute(
            &format!("UPDATE pop3_uidls SET {sql} WHERE account_id = ?1 AND uidl = ?2"),
            rusqlite::params![t.account.id, uidl],
        )
        .unwrap();
    }

    #[tokio::test]
    async fn first_sync_stores_all_new_mails() {
        let t = env("keep");
        let report = run(&t, vec![
            uidl(&[(1, "u1"), (2, "u2")]),
            list(&[(1, 400), (2, 400)]),
            retr(2, &mail("m2", "Zweite")),
            retr(1, &mail("m1", "Erste")),
            QUIT,
        ])
        .await
        .unwrap();
        assert_eq!(report.new_mail_ids.len(), 2);
        assert_eq!(report.deleted_on_server, 0);
        let mails = inbox_mails(&t);
        assert_eq!(mails.len(), 2);
        assert!(mails.iter().all(|m| !m.2 && !m.3.trim().is_empty()));
        assert_eq!(source_files(&t), 2);
        for (id, ..) in &mails {
            assert!(crate::pop3::store::has_source(&t.dir, id));
        }
        let rows = uidl_rows(&t);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.2 == "stored" && r.1.is_some()));
    }

    #[tokio::test]
    async fn second_sync_fetches_only_new_uidl() {
        let t = env("keep");
        run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), retr(1, &mail("m1", "Erste")), QUIT])
            .await
            .unwrap();
        let report = run(&t, vec![
            uidl(&[(1, "u1"), (2, "u2")]),
            list(&[(1, 400), (2, 400)]),
            retr(2, &mail("m2", "Zweite")),
            QUIT,
        ])
        .await
        .unwrap();
        assert_eq!(report.new_mail_ids.len(), 1);
        assert_eq!(inbox_mails(&t).len(), 2);
        assert_eq!(uidl_rows(&t).len(), 2);
    }

    #[tokio::test]
    async fn after_fetch_sends_dele_then_quit_and_marks_deleted() {
        let t = env("after_fetch");
        let report = run(&t, vec![
            uidl(&[(1, "u1"), (2, "u2")]),
            list(&[(1, 400), (2, 400)]),
            retr(2, &mail("m2", "Zweite")),
            retr(1, &mail("m1", "Erste")),
            dele(1),
            dele(2),
            QUIT,
        ])
        .await
        .unwrap();
        assert_eq!(report.deleted_on_server, 2);
        assert!(uidl_rows(&t).iter().all(|r| r.2 == "server_deleted"));
        assert_eq!(inbox_mails(&t).len(), 2);
        assert_eq!(source_files(&t), 2);
    }

    #[tokio::test]
    async fn abort_mid_retr_keeps_earlier_mails_and_sends_no_dele() {
        let t = env("after_fetch");
        let result = run(&t, vec![
            uidl(&[(1, "u1"), (2, "u2")]),
            list(&[(1, 400), (2, 400)]),
            retr(2, &mail("m2", "Zweite")),
            ("RETR 1", "+OK\r\nFrom: Anna Weber <anna@studio-halde.example>\r\n"),
            ("", "<DROP>"),
        ])
        .await;
        assert!(result.is_err());
        let rows = uidl_rows(&t);
        assert_eq!(rows.len(), 1);
        assert_eq!((rows[0].0.as_str(), rows[0].2.as_str()), ("u2", "stored"));
        assert_eq!(inbox_mails(&t).len(), 1);

        let report = run(&t, vec![
            uidl(&[(1, "u1"), (2, "u2")]),
            list(&[(1, 400), (2, 400)]),
            retr(1, &mail("m1", "Erste")),
            dele(1),
            dele(2),
            QUIT,
        ])
        .await
        .unwrap();
        assert_eq!(report.new_mail_ids.len(), 1);
        assert_eq!(report.deleted_on_server, 2);
        assert_eq!(inbox_mails(&t).len(), 2);
    }

    #[tokio::test]
    async fn quit_failure_leaves_state_stored() {
        let t = env("after_fetch");
        let report = run(&t, vec![
            uidl(&[(1, "u1")]),
            list(&[(1, 400)]),
            retr(1, &mail("m1", "Erste")),
            dele(1),
            ("QUIT", "<DROP>"),
        ])
        .await
        .unwrap();
        assert_eq!(report.deleted_on_server, 0);
        assert_eq!(report.new_mail_ids.len(), 1);
        assert_eq!(uidl_rows(&t)[0].2, "stored");

        let report = run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), dele(1), QUIT])
            .await
            .unwrap();
        assert_eq!(report.deleted_on_server, 1);
        assert!(report.new_mail_ids.is_empty());
        assert_eq!(uidl_rows(&t)[0].2, "server_deleted");
    }

    #[tokio::test]
    async fn duplicate_message_id_with_identical_bytes_maps_to_existing_mail() {
        let t = env("after_fetch");
        let report = run(&t, vec![
            uidl(&[(1, "u1"), (2, "u2")]),
            list(&[(1, 400), (2, 400)]),
            retr(2, &mail("gleich", "Doppelt")),
            retr(1, &mail("gleich", "Doppelt")),
            dele(1),
            dele(2),
            QUIT,
        ])
        .await
        .unwrap();
        let mails = inbox_mails(&t);
        assert_eq!(mails.len(), 1);
        assert_eq!(report.new_mail_ids, vec![mails[0].0.clone()]);
        assert_eq!(report.deleted_on_server, 2);
        assert_eq!(mail_of(&t, "u1"), mails[0].0);
        assert_eq!(mail_of(&t, "u2"), mails[0].0);
        assert_eq!(source_files(&t), 1);
        assert!(crate::pop3::store::has_source(&t.dir, &mails[0].0));
    }

    #[tokio::test]
    async fn duplicate_message_id_with_different_bytes_is_never_deleted() {
        let t = env("after_fetch");
        let report = run(&t, vec![
            uidl(&[(1, "u1"), (2, "u2")]),
            list(&[(1, 400), (2, 400)]),
            retr(2, &mail("gleich", "Doppelt")),
            retr(1, &mail("gleich", "Anders")),
            dele(2),
            QUIT,
        ])
        .await
        .unwrap();
        assert_eq!(report.deleted_on_server, 1);
        assert_eq!(inbox_mails(&t).len(), 1);
        assert_eq!(source_files(&t), 1);
        let rows = uidl_rows(&t);
        assert_eq!(rows[0], ("u1".to_string(), None, "stored".to_string()));
        assert_eq!(rows[1].2, "server_deleted");

        let report = run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), QUIT]).await.unwrap();
        assert!(report.new_mail_ids.is_empty());
        assert_eq!(report.deleted_on_server, 0);
    }

    #[tokio::test]
    async fn existing_mail_without_source_gets_the_new_source() {
        let t = env("keep");
        run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), retr(1, &mail("m1", "Erste")), QUIT])
            .await
            .unwrap();
        let mail_id = mail_of(&t, "u1");
        std::fs::remove_file(crate::pop3::store::source_path(&t.dir, &mail_id)).unwrap();
        let report = run(&t, vec![
            uidl(&[(1, "u1"), (2, "u9")]),
            list(&[(1, 400), (2, 400)]),
            retr(2, &mail("m1", "Erste")),
            QUIT,
        ])
        .await
        .unwrap();
        assert!(report.new_mail_ids.is_empty());
        assert_eq!(mail_of(&t, "u9"), mail_id);
        assert!(crate::pop3::store::has_source(&t.dir, &mail_id));
        assert_eq!(source_files(&t), 1);
    }

    #[tokio::test]
    async fn dele_refusal_is_skipped_and_session_quits() {
        let t = env("after_fetch");
        let report = run(&t, vec![
            uidl(&[(1, "u1"), (2, "u2")]),
            list(&[(1, 400), (2, 400)]),
            retr(2, &mail("m2", "Zweite")),
            retr(1, &mail("m1", "Erste")),
            ("DELE 1", "-ERR message locked\r\n"),
            dele(2),
            QUIT,
        ])
        .await
        .unwrap();
        assert_eq!(report.deleted_on_server, 1);
        let rows = uidl_rows(&t);
        assert_eq!(rows[0].2, "stored");
        assert_eq!(rows[1].2, "server_deleted");
    }

    #[tokio::test]
    async fn connection_drop_on_dele_aborts_without_marking() {
        let t = env("after_fetch");
        let result = run(&t, vec![
            uidl(&[(1, "u1"), (2, "u2")]),
            list(&[(1, 400), (2, 400)]),
            retr(2, &mail("m2", "Zweite")),
            retr(1, &mail("m1", "Erste")),
            dele(1),
            ("DELE 2", "<DROP>"),
        ])
        .await;
        assert!(result.is_err());
        let rows = uidl_rows(&t);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|r| r.2 == "stored"));
    }

    #[tokio::test]
    async fn unparseable_mail_is_kept_as_placeholder() {
        let t = env("keep");
        run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 20)]), retr(1, "\r\n\r\n"), QUIT])
            .await
            .unwrap();
        assert_eq!(inbox_mails(&t).len(), 1);
        let mail_id = mail_of(&t, "u1");
        assert!(crate::pop3::store::has_source(&t.dir, &mail_id));
        assert_eq!(uidl_rows(&t)[0].2, "stored");
    }

    #[tokio::test]
    async fn too_large_mail_is_skipped_and_never_deleted() {
        let t = env("after_fetch");
        let report = run(&t, vec![
            uidl(&[(1, "u1"), (2, "u2")]),
            list(&[(1, 200 * 1024 * 1024), (2, 400)]),
            retr(2, &mail("m2", "Zweite")),
            dele(2),
            QUIT,
        ])
        .await
        .unwrap();
        assert_eq!(report.skipped_too_large, 1);
        assert_eq!(report.deleted_on_server, 1);
        let rows = uidl_rows(&t);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "u2");

        let report = run(&t, vec![
            uidl(&[(1, "u1")]),
            list(&[(1, 200 * 1024 * 1024)]),
            QUIT,
        ])
        .await
        .unwrap();
        assert_eq!(report.skipped_too_large, 1);
        assert_eq!(report.deleted_on_server, 0);
    }

    #[tokio::test]
    async fn missing_source_file_blocks_dele() {
        let mut t = env("keep");
        run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), retr(1, &mail("m1", "Erste")), QUIT])
            .await
            .unwrap();
        std::fs::remove_file(crate::pop3::store::source_path(&t.dir, &mail_of(&t, "u1"))).unwrap();
        t.account.pop3_delete_mode = "after_fetch".into();
        let report = run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), QUIT]).await.unwrap();
        assert_eq!(report.deleted_on_server, 0);
        assert_eq!(uidl_rows(&t)[0].2, "stored");
    }

    #[tokio::test]
    async fn vanished_uidl_rows_are_pruned() {
        let t = env("keep");
        run(&t, vec![
            uidl(&[(1, "u1"), (2, "u2")]),
            list(&[(1, 400), (2, 400)]),
            retr(2, &mail("m2", "Zweite")),
            retr(1, &mail("m1", "Erste")),
            QUIT,
        ])
        .await
        .unwrap();
        run(&t, vec![uidl(&[(1, "u2")]), list(&[(1, 400)]), QUIT]).await.unwrap();
        let rows = uidl_rows(&t);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].0, "u2");
        assert_eq!(inbox_mails(&t).len(), 2);
    }

    #[tokio::test]
    async fn no_uidl_server_aborts_without_changes() {
        let t = env("after_fetch");
        let result = run(&t, vec![("UIDL", "-ERR command not supported\r\n")]).await;
        assert!(matches!(result, Err(Pop3Error::NoUidl)));
        assert!(uidl_rows(&t).is_empty());
        assert!(inbox_mails(&t).is_empty());
        assert!(!t.dir.exists());
    }

    #[tokio::test]
    async fn with_local_deletes_locally_deleted_mail_immediately() {
        let mut t = env("after_days");
        t.account.pop3_delete_with_local = true;
        run(&t, vec![uidl(&[(1, "u1"), (2, "u2")]), list(&[(1, 400), (2, 400)]),
            retr(2, &mail("m2", "Zweite")), retr(1, &mail("m1", "Erste")), QUIT])
            .await
            .unwrap();
        set_column(&t, "u2", "local_deleted_at = datetime('now')");
        let report = run(&t, vec![uidl(&[(1, "u1"), (2, "u2")]), list(&[(1, 400), (2, 400)]), dele(2), QUIT])
            .await
            .unwrap();
        assert_eq!(report.deleted_on_server, 1);
        let rows = uidl_rows(&t);
        assert_eq!(rows[0].2, "stored");
        assert_eq!(rows[1].2, "server_deleted");
    }

    #[tokio::test]
    async fn fourteen_day_rule_deletes_only_old_mails() {
        let t = env("after_days");
        run(&t, vec![uidl(&[(1, "u1"), (2, "u2")]), list(&[(1, 400), (2, 400)]),
            retr(2, &mail("m2", "Zweite")), retr(1, &mail("m1", "Erste")), QUIT])
            .await
            .unwrap();
        set_column(&t, "u1", "fetched_at = datetime('now', '-15 days')");
        set_column(&t, "u2", "fetched_at = datetime('now', '-3 days')");
        let report = run(&t, vec![uidl(&[(1, "u1"), (2, "u2")]), list(&[(1, 400), (2, 400)]), dele(1), QUIT])
            .await
            .unwrap();
        assert_eq!(report.deleted_on_server, 1);
        let rows = uidl_rows(&t);
        assert_eq!(rows[0].2, "server_deleted");
        assert_eq!(rows[1].2, "stored");
    }

    #[tokio::test]
    async fn missing_inbox_aborts_before_retr() {
        let t = env("after_fetch");
        t.db.lock_db().execute("DELETE FROM folders WHERE id = ?1", [&t.inbox]).unwrap();
        let result = run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)])]).await;
        assert!(matches!(result, Err(Pop3Error::NoInbox)));
        assert!(uidl_rows(&t).is_empty());
    }

    #[test]
    fn sync_future_is_send() {
        fn assert_send<T: Send>(_: T) {}
        let t = env("keep");
        assert_send(sync_pop3_account(&t.db, &t.dir, &t.account, "geheim"));
    }
}
