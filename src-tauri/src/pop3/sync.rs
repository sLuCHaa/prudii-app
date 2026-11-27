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

pub async fn fetch_pop3_mails(
    db: &Database,
    data_dir: &Path,
    mailbox: &Account,
    password: &str,
) -> Result<Pop3SyncReport, Pop3Error> {
    let security: Pop3Security = mailbox.incoming_security.parse()?;
    let port = u16::try_from(mailbox.imap_port)
        .map_err(|_| Pop3Error::Io(format!("invalid port {}", mailbox.imap_port)))?;
    let mut client = super::connect(&mailbox.imap_host, port, security).await?;
    client.capa().await?;
    client.login(&mailbox.email, password).await?;
    sync_with_client(client, db, data_dir, mailbox).await
}

/// Errors return without QUIT on purpose: the server then discards every DELE of the session.
pub(crate) async fn sync_with_client<S: AsyncRead + AsyncWrite + Unpin>(
    mut client: Pop3Client<S>,
    db: &Database,
    data_dir: &Path,
    mailbox: &Account,
) -> Result<Pop3SyncReport, Pop3Error> {
    let server = server_key(mailbox);
    // Done here, not on settings save: a sync with the old account state may still be recording rows then.
    reset_foreign_rows(db, data_dir, &mailbox.id, &server)?;
    let listing = client.uidl_all().await?;
    let sizes: HashMap<u32, u64> = client.list_all().await?.into_iter().collect();
    let inbox = inbox_folder_id(db, &mailbox.id)?;

    let server_uidls: HashSet<String> = listing.iter().map(|(_, uidl)| uidl.clone()).collect();
    let mut numbers: HashMap<&str, Option<u32>> = HashMap::new();
    for (msg, uidl) in &listing {
        numbers
            .entry(uidl.as_str())
            .and_modify(|n| *n = None)
            .or_insert(Some(*msg));
    }

    let known: HashSet<String> = load_rows(db, &mailbox.id, &server)?.into_iter().map(|r| r.uidl).collect();
    let mut fresh: Vec<(u32, &str)> = listing
        .iter()
        .filter(|(_, uidl)| !known.contains(uidl))
        .map(|(msg, uidl)| (*msg, uidl.as_str()))
        .collect();
    fresh.sort_by_key(|entry| std::cmp::Reverse(entry.0));

    let mut report = Pop3SyncReport::default();
    let mut seen = HashSet::new();
    for (msg, server_ref) in fresh {
        if !seen.insert(server_ref) {
            continue;
        }
        if sizes.get(&msg).is_some_and(|&size| size > MAX_MESSAGE_BYTES) {
            skip_too_large(&mut report);
            continue;
        }
        let raw = match client.retr(msg, MAX_MESSAGE_BYTES).await {
            Ok(raw) => raw,
            Err(Pop3Error::TooLarge(_)) => {
                skip_too_large(&mut report);
                continue;
            }
            Err(e) => return Err(e),
        };
        if let Some(mail_id) = store_fetched(db, data_dir, mailbox, &inbox, server_ref, &raw).await? {
            report.new_mail_ids.push(mail_id);
        }
    }

    prune_vanished(db, data_dir, &mailbox.id, &server, &server_uidls)?;

    let rows = load_rows(db, &mailbox.id, &server)?;
    let mail_ids: HashMap<&str, &str> = rows
        .iter()
        .filter_map(|r| r.mail_id.as_deref().map(|m| (r.uidl.as_str(), m)))
        .collect();
    let mut targets: Vec<(u32, String)> = Vec::new();
    for uidl in store::plan_deletions(Utc::now(), &delete_policy(mailbox), &rows, &server_uidls) {
        match numbers.get(uidl.as_str()) {
            Some(Some(msg)) => targets.push((*msg, uidl)),
            _ => log::warn!("POP3: no unique message number for a planned delete, kept on server"),
        }
    }
    targets.sort();

    if !targets.is_empty() {
        if let Err(e) = flush_database(db) {
            log::warn!("POP3: database not flushed, server deletes skipped this run: {}", e);
            targets.clear();
        }
    }

    let mut deleted = Vec::new();
    for (msg, uidl) in targets {
        let Some(mail_id) = mail_ids.get(uidl.as_str()) else { continue };
        if !store::has_source(data_dir, mail_id) {
            log::warn!("POP3: raw source missing, kept on server");
            continue;
        }
        if !mail_kept_or_deleted_by_user(db, &mailbox.id, &uidl)? {
            log::warn!("POP3: local mail missing, kept on server");
            continue;
        }
        match client.dele(msg).await? {
            Ok(()) => deleted.push(uidl),
            Err(_) => log::warn!("POP3: DELE refused, message kept on server"),
        }
    }

    if client.quit().await.is_err() {
        log::warn!("POP3: QUIT failed, server deletes are retried next run");
        return Ok(report);
    }
    match mark_server_deleted(db, &mailbox.id, &deleted) {
        Ok(marked) => {
            report.deleted_on_server = marked;
            let gone: Vec<String> = deleted
                .iter()
                .filter_map(|uidl| mail_ids.get(uidl.as_str()).map(|id| id.to_string()))
                .collect();
            super::discard_orphan_sources(&db.lock_db(), data_dir, &gone);
        }
        Err(e) => log::warn!("POP3: could not mark server deletes: {}", e),
    }
    Ok(report)
}

// WAL with synchronous=NORMAL can lose committed rows on power loss; the server copy must not go before they are durable.
fn flush_database(db: &Database) -> Result<(), Pop3Error> {
    let busy: i64 = db
        .lock_db()
        .query_row("PRAGMA wal_checkpoint(FULL)", [], |r| r.get(0))
        .map_err(db_error)?;
    if busy != 0 {
        return Err(Pop3Error::Database("checkpoint blocked".into()));
    }
    Ok(())
}

fn skip_too_large(report: &mut Pop3SyncReport) {
    log::warn!("POP3: a message is too large, left on the server");
    report.skipped_too_large += 1;
}

/// Returns the id of a newly inserted mail; None when the UIDL maps to an existing mail or nothing was stored.
async fn store_fetched(
    db: &Database,
    data_dir: &Path,
    mailbox: &Account,
    inbox: &str,
    server_ref: &str,
    raw: &[u8],
) -> Result<Option<String>, Pop3Error> {
    let owner_id = mailbox.id.as_str();
    let mail_id = uuid::Uuid::new_v4().to_string();
    store::write_source(data_dir, &mail_id, raw).map_err(|e| Pop3Error::Storage(e.to_string()))?;
    let outcome = match crate::imap::insert_local_mail(db, owner_id, inbox, &mail_id, raw, false) {
        Ok(outcome) => outcome,
        Err(e) => {
            remove_source(data_dir, &mail_id);
            return Err(Pop3Error::Database(e.to_string()));
        }
    };
    match outcome {
        InsertOutcome::Inserted(id) => {
            if !record_uidl(db, data_dir, mailbox, server_ref, Some(&id), &id)? {
                return Ok(None);
            }
            if crate::imap::store_body_and_attachments(db, &id, raw).await.is_err() {
                log::warn!("POP3: storing body and attachments of a message failed");
            }
            Ok(Some(id))
        }
        InsertOutcome::Existing(existing) => {
            claim_existing(db, data_dir, mailbox, server_ref, &mail_id, &existing, raw)?;
            Ok(None)
        }
        InsertOutcome::NotStored => {
            log::warn!("POP3: a message could not be stored, left on the server");
            remove_source(data_dir, &mail_id);
            Ok(None)
        }
    }
}

/// Maps the UIDL to a mail with the same Message-ID, handing it the new source if it has none.
fn claim_existing(
    db: &Database,
    data_dir: &Path,
    mailbox: &Account,
    server_ref: &str,
    mail_id: &str,
    existing: &str,
    raw: &[u8],
) -> Result<(), Pop3Error> {
    let mapped = if store::has_source(data_dir, existing) {
        remove_source(data_dir, mail_id);
        let stored = store::read_source(data_dir, existing).map_err(|e| Pop3Error::Storage(e.to_string()))?;
        let same = stored == raw;
        if !same {
            log::warn!("POP3: a message reuses the Message-ID of a stored mail, left on the server");
        }
        same
    } else {
        if let Err(e) = store::move_source(data_dir, mail_id, existing) {
            remove_source(data_dir, mail_id);
            return Err(Pop3Error::Storage(e.to_string()));
        }
        true
    };
    record_uidl(db, data_dir, mailbox, server_ref, mapped.then_some(existing), existing).map(drop)
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
/// False when the mail row is gone meanwhile: the UIDL stays unknown and is fetched again.
fn record_uidl(
    db: &Database,
    data_dir: &Path,
    mailbox: &Account,
    uidl: &str,
    mail_id: Option<&str>,
    row_id: &str,
) -> Result<bool, Pop3Error> {
    let fetched_at = Utc::now().format(FETCHED_AT_FORMAT).to_string();
    let conn = db.lock_db();
    // One statement, so the mail row cannot disappear between check and insert.
    let written = conn
        .execute(
            "INSERT INTO pop3_uidls (account_id, uidl, mail_id, fetched_at, state, server)
             SELECT ?1, ?2, ?3, ?4, 'stored', ?5 WHERE EXISTS(SELECT 1 FROM mails WHERE id = ?6)",
            rusqlite::params![mailbox.id, uidl, mail_id, fetched_at, server_key(mailbox), row_id],
        )
        .map_err(db_error)?;
    if written == 0 {
        super::discard_orphan_sources(&conn, data_dir, &[row_id.to_string()]);
    }
    Ok(written > 0)
}

fn mail_kept_or_deleted_by_user(db: &Database, account_id: &str, uidl: &str) -> Result<bool, Pop3Error> {
    db.lock_db()
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pop3_uidls u WHERE u.account_id = ?1 AND u.uidl = ?2
                 AND (u.local_deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM mails WHERE id = u.mail_id)))",
            [account_id, uidl],
            |r| r.get(0),
        )
        .map_err(db_error)
}

fn load_rows(db: &Database, account_id: &str, server: &str) -> Result<Vec<UidlRow>, Pop3Error> {
    let now = Utc::now();
    let conn = db.lock_db();
    let mut stmt = conn
        .prepare("SELECT uidl, mail_id, fetched_at, state, local_deleted_at FROM pop3_uidls WHERE account_id = ?1 AND server = ?2")
        .map_err(db_error)?;
    let rows = stmt
        .query_map([account_id, server], |r| {
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

/// Identifies the mailbox a UIDL belongs to, from the values the session connects with.
fn server_key(account: &Account) -> String {
    format!("{}|{}|{}", account.imap_host.trim().to_lowercase(), account.imap_port, account.email)
}

fn reset_foreign_rows(db: &Database, data_dir: &Path, account_id: &str, server: &str) -> Result<(), Pop3Error> {
    let mut conn = db.lock_db();
    let tx = conn.transaction().map_err(db_error)?;
    let orphaned = tx
        .prepare("DELETE FROM pop3_uidls WHERE account_id = ?1 AND server IS NOT ?2 RETURNING mail_id")
        .and_then(|mut stmt| {
            stmt.query_map([account_id, server], |r| r.get::<_, Option<String>>(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    let orphaned: Vec<String> = orphaned.into_iter().flatten().collect();
    super::discard_orphan_sources(&conn, data_dir, &orphaned);
    Ok(())
}

fn delete_policy(account: &Account) -> DeletePolicy {
    let mode = match account.pop3_delete_mode.as_str() {
        "after_fetch" => DeleteMode::AfterFetch,
        "after_days" => DeleteMode::AfterDays(account.pop3_delete_after_days.max(0)),
        _ => DeleteMode::Keep,
    };
    DeletePolicy { mode, with_local: account.pop3_delete_with_local }
}

fn prune_vanished(
    db: &Database,
    data_dir: &Path,
    account_id: &str,
    server: &str,
    server_uidls: &HashSet<String>,
) -> Result<(), Pop3Error> {
    let (vanished, orphaned): (Vec<String>, Vec<Option<String>>) = load_rows(db, account_id, server)?
        .into_iter()
        .filter(|r| !server_uidls.contains(&r.uidl))
        .map(|r| (r.uidl, r.mail_id))
        .unzip();
    update_each(db, account_id, &vanished, "DELETE FROM pop3_uidls WHERE account_id = ?1 AND uidl = ?2")?;
    let orphaned: Vec<String> = orphaned.into_iter().flatten().collect();
    super::discard_orphan_sources(&db.lock_db(), data_dir, &orphaned);
    Ok(())
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
    async fn failed_source_attach_aborts_without_uidl_row() {
        let t = env("after_fetch");
        run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), retr(1, &mail("m1", "Erste")), dele(1), QUIT])
            .await
            .unwrap();
        let mail_id = mail_of(&t, "u1");
        let path = crate::pop3::store::source_path(&t.dir, &mail_id);
        std::fs::remove_file(&path).unwrap();
        std::fs::create_dir(&path).unwrap();
        let result = run(&t, vec![uidl(&[(1, "u1"), (2, "u9")]), list(&[(1, 400), (2, 400)]), retr(2, &mail("m1", "Erste"))]).await;
        assert!(matches!(result, Err(Pop3Error::Storage(_))));
        assert_eq!(uidl_rows(&t).len(), 1);
        assert_eq!(source_files(&t), 1);
    }

    #[test]
    fn vanished_existing_mail_gets_no_uidl() {
        let raw = mail("m1", "Erste");
        for stored in [None, Some(raw.as_str()), Some("anders")] {
            let t = env("after_fetch");
            crate::pop3::store::write_source(&t.dir, "new", raw.as_bytes()).unwrap();
            if let Some(stored) = stored {
                crate::pop3::store::write_source(&t.dir, "gone", stored.as_bytes()).unwrap();
            }
            claim_existing(&t.db, &t.dir, &t.account, "u1", "new", "gone", raw.as_bytes()).unwrap();
            assert!(uidl_rows(&t).is_empty());
            assert_eq!(source_files(&t), 0);
        }
    }

    #[tokio::test]
    async fn missing_mail_row_without_local_delete_blocks_dele() {
        let mut t = env("keep");
        let mail_id = store_first(&t).await;
        t.db.lock_db().execute("DELETE FROM mails WHERE id = ?1", [&mail_id]).unwrap();
        t.account.pop3_delete_mode = "after_fetch".into();
        let report = run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), QUIT]).await.unwrap();
        assert_eq!(report.deleted_on_server, 0);
        assert_eq!(uidl_rows(&t)[0].2, "stored");
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
        assert_eq!(source_files(&t), 2);
    }

    fn server_of(t: &Env, uidl: &str) -> Option<String> {
        t.db.lock_db()
            .query_row(
                "SELECT server FROM pop3_uidls WHERE account_id = ?1 AND uidl = ?2",
                rusqlite::params![t.account.id, uidl],
                |r| r.get(0),
            )
            .unwrap()
    }

    async fn store_first(t: &Env) -> String {
        run(t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), retr(1, &mail("m1", "Erste")), QUIT])
            .await
            .unwrap();
        mail_of(t, "u1")
    }

    fn delete_locally(t: &Env, mail_id: &str) {
        let conn = t.db.lock_db();
        crate::pop3::mark_locally_deleted(&conn, &t.account.id, &[mail_id.to_string()]).unwrap();
        conn.execute("DELETE FROM mails WHERE id = ?1", [mail_id]).unwrap();
    }

    #[tokio::test]
    async fn server_change_never_deletes_with_old_uidls() {
        let changes: [fn(&mut Env); 4] = [
            |t| t.account.imap_host = "pop2.studio-halde.example".into(),
            |t| t.account.imap_port = 110,
            |t| t.account.email = "anna.weber@studio-halde.example".into(),
            |t| set_column(t, "u1", "server = NULL"),
        ];
        for change in changes {
            let mut t = env("keep");
            t.account.pop3_delete_with_local = true;
            let old = store_first(&t).await;
            delete_locally(&t, &old);
            assert!(crate::pop3::store::has_source(&t.dir, &old));
            change(&mut t);
            let report = run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), retr(1, &mail("m1", "Erste")), QUIT])
                .await
                .unwrap();
            assert_eq!(report.deleted_on_server, 0);
            assert_eq!(report.new_mail_ids, vec![mail_of(&t, "u1")]);
            assert_ne!(mail_of(&t, "u1"), old);
            assert!(!crate::pop3::store::has_source(&t.dir, &old));
            assert_eq!(source_files(&t), 1);
            assert_eq!(server_of(&t, "u1"), Some(server_key(&t.account)));
        }
    }

    #[tokio::test]
    async fn unchanged_server_keeps_rows() {
        let mut t = env("keep");
        let mail_id = store_first(&t).await;
        assert_eq!(
            server_of(&t, "u1").as_deref(),
            Some("pop.studio-halde.example|995|anna@studio-halde.example")
        );
        t.account.imap_host = " POP.Studio-Halde.Example ".into();
        let report = run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), QUIT]).await.unwrap();
        assert!(report.new_mail_ids.is_empty());
        assert_eq!(mail_of(&t, "u1"), mail_id);
    }

    #[tokio::test]
    async fn locally_deleted_mail_keeps_source_until_server_deleted() {
        let mut t = env("keep");
        t.account.pop3_delete_with_local = true;
        let mail_id = store_first(&t).await;
        delete_locally(&t, &mail_id);
        assert!(crate::pop3::store::has_source(&t.dir, &mail_id));

        let report = run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), dele(1), ("QUIT", "<DROP>")])
            .await
            .unwrap();
        assert_eq!(report.deleted_on_server, 0);
        assert!(crate::pop3::store::has_source(&t.dir, &mail_id));

        let report = run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), dele(1), QUIT]).await.unwrap();
        assert_eq!(report.deleted_on_server, 1);
        assert_eq!(uidl_rows(&t)[0].2, "server_deleted");
        assert!(!crate::pop3::store::has_source(&t.dir, &mail_id));
    }

    #[tokio::test]
    async fn keep_without_local_delete_holds_source_until_uidl_vanishes() {
        let t = env("keep");
        let mail_id = store_first(&t).await;
        delete_locally(&t, &mail_id);
        let report = run(&t, vec![uidl(&[(1, "u1")]), list(&[(1, 400)]), QUIT]).await.unwrap();
        assert!(report.new_mail_ids.is_empty());
        assert_eq!(uidl_rows(&t).len(), 1);
        assert!(crate::pop3::store::has_source(&t.dir, &mail_id));

        run(&t, vec![uidl(&[]), list(&[]), QUIT]).await.unwrap();
        assert!(uidl_rows(&t).is_empty());
        assert!(!crate::pop3::store::has_source(&t.dir, &mail_id));
    }

    #[tokio::test]
    async fn discard_removes_only_unreferenced_sources() {
        let t = env("keep");
        let mail_id = store_first(&t).await;
        let ids = [mail_id.clone()];
        let discard = || crate::pop3::discard_orphan_sources(&t.db.lock_db(), &t.dir, &ids);
        let exists = || crate::pop3::store::has_source(&t.dir, &mail_id);

        set_column(&t, "u1", "state = 'server_deleted'");
        discard();
        assert!(exists());

        set_column(&t, "u1", "state = 'stored'");
        t.db.lock_db().execute("DELETE FROM mails WHERE id = ?1", [&mail_id]).unwrap();
        discard();
        assert!(exists());

        t.db.lock_db().execute_batch("ALTER TABLE pop3_uidls RENAME TO pop3_uidls_away").unwrap();
        discard();
        assert!(exists());
        t.db.lock_db().execute_batch("ALTER TABLE pop3_uidls_away RENAME TO pop3_uidls").unwrap();

        set_column(&t, "u1", "state = 'server_deleted'");
        discard();
        assert!(!exists());
    }

    #[test]
    fn mark_locally_deleted_handles_many_ids() {
        let t = env("keep");
        let ids: Vec<String> = (0..1500).map(|n| format!("mail-{n}")).collect();
        let conn = t.db.lock_db();
        let other = seed_account(&conn, "info@studio-halde.example");
        for (n, id) in ids.iter().enumerate() {
            conn.execute(
                "INSERT INTO pop3_uidls (account_id, uidl, mail_id) VALUES (?1, ?2, ?3)",
                rusqlite::params![t.account.id, format!("u{n}"), id],
            )
            .unwrap();
        }
        conn.execute(
            "INSERT INTO pop3_uidls (account_id, uidl, mail_id) VALUES (?1, 'u0', 'mail-0')",
            [&other],
        )
        .unwrap();
        let changed = crate::pop3::mark_locally_deleted(&conn, &t.account.id, &ids).unwrap();
        assert_eq!(changed, 1500);
        let open: i64 = conn
            .query_row("SELECT COUNT(*) FROM pop3_uidls WHERE local_deleted_at IS NULL", [], |r| r.get(0))
            .unwrap();
        assert_eq!(open, 1);
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
        assert_send(fetch_pop3_mails(&t.db, &t.dir, &t.account, &uuid::Uuid::new_v4().to_string()));
    }
}
