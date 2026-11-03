use super::key::{matches, KeyKind, MailFacts};
use super::store::{self, parse_stamp, Unsubscription};
use crate::categorize::store::{load_correspondents, protected_from_cleanup};
use crate::db::Database;
use rusqlite::Connection;
use std::collections::{HashMap, HashSet};

struct Candidate {
    id: String,
    from_email: String,
    signal_headers: String,
    list_unsubscribe: String,
    date: String,
    message_id: String,
    folder_path: String,
    folder_type: String,
}

impl Candidate {
    fn facts(&self) -> MailFacts<'_> {
        MailFacts { from_email: &self.from_email, signal_headers: &self.signal_headers, list_unsubscribe: &self.list_unsubscribe }
    }
}

const CANDIDATE_COLUMNS: &str = "m.id, COALESCE(m.from_email, ''), COALESCE(m.signal_headers, ''), COALESCE(m.list_unsubscribe, ''),
     COALESCE(m.date, ''), COALESCE(m.message_id, ''), COALESCE(f.path, ''), COALESCE(f.folder_type, '')";

fn candidate(r: &rusqlite::Row) -> rusqlite::Result<Candidate> {
    Ok(Candidate {
        id: r.get(0)?,
        from_email: r.get(1)?,
        signal_headers: r.get(2)?,
        list_unsubscribe: r.get(3)?,
        date: r.get(4)?,
        message_id: r.get(5)?,
        folder_path: r.get(6)?,
        folder_type: r.get(7)?,
    })
}

fn load_candidates(conn: &Connection, account_id: &str, mail_ids: &[String]) -> Vec<Candidate> {
    let placeholders = std::iter::repeat_n("?", mail_ids.len()).collect::<Vec<_>>().join(",");
    let sql = format!(
        "SELECT {CANDIDATE_COLUMNS} FROM mails m LEFT JOIN folders f ON m.folder_id = f.id WHERE m.account_id = ? AND m.id IN ({placeholders})"
    );
    let mut params: Vec<&dyn rusqlite::ToSql> = vec![&account_id];
    params.extend(mail_ids.iter().map(|s| s as &dyn rusqlite::ToSql));
    conn.prepare(&sql)
        .and_then(|mut stmt| stmt.query_map(params.as_slice(), candidate)?.collect())
        .unwrap_or_else(|e| {
            log::warn!("unsubscribe sweep: loading mails failed: {}", e);
            Vec::new()
        })
}

/// Returns only the ids it left alone, so a rule never pulls a swept mail back out of the trash.
pub fn sweep_new_mails(account_id: &str, mail_ids: &[String], db: &Database) -> Vec<String> {
    if mail_ids.is_empty() {
        return Vec::new();
    }
    let conn = db.lock_db();
    let subs = match store::for_account(&conn, account_id) {
        Ok(subs) if !subs.is_empty() => subs,
        _ => return mail_ids.to_vec(),
    };
    let now = chrono::Utc::now();
    let is_gmail = crate::rules::is_gmail_account(&conn, account_id);
    let mut correspondents: Option<HashMap<String, u32>> = None;
    let mut swept: HashSet<String> = HashSet::new();
    let tx = conn.unchecked_transaction();
    for mail in load_candidates(&conn, account_id, mail_ids) {
        let facts = mail.facts();
        let Some(sub) = subs.iter().find(|s| matches(&s.key.kind, &s.key.value, s.blocked, &facts)) else { continue };
        let Some(date) = parse_stamp(&mail.date) else { continue };
        if date <= sub.sweep_after || mail.folder_type == "trash" {
            continue;
        }
        // The mail's own date decides whether it came after a retry; a forged future date is capped.
        let seen_at = date.min(now);
        let known = correspondents.get_or_insert_with(|| load_correspondents(&conn));
        if protected_from_cleanup(&conn, &mail.id, known) {
            let _ = store::record_seen(&conn, &sub.id, seen_at);
            continue;
        }
        // Moving spam would only shuffle it between two junk folders; the hit still counts.
        if mail.folder_type == "spam" || crate::rules::trash_mail(&conn, account_id, &mail.id, &mail.message_id, &mail.folder_path, is_gmail) {
            let _ = store::record_sorted(&conn, &sub.id, seen_at);
            if mail.folder_type != "spam" {
                swept.insert(mail.id);
            }
        }
    }
    if let Ok(tx) = tx {
        let _ = tx.commit();
    }
    mail_ids.iter().filter(|id| !swept.contains(*id)).cloned().collect()
}

pub(crate) fn trash_existing(conn: &Connection, sub: &Unsubscription, correspondents: &HashMap<String, u32>) -> u32 {
    // SQL narrows the scan; `matches` below stays the authority.
    let narrow = match sub.key.kind {
        KeyKind::ListId => "instr(lower(COALESCE(m.signal_headers, '')), ?2) > 0",
        KeyKind::Sender => "lower(m.from_email) = ?2",
    };
    let sql = format!(
        "SELECT {CANDIDATE_COLUMNS} FROM mails m JOIN folders f ON m.folder_id = f.id
         WHERE m.account_id = ?1 AND f.folder_type NOT IN ('trash', 'spam') AND COALESCE(f.is_local, 0) = 0 AND {narrow}"
    );
    let mails: Vec<Candidate> = conn
        .prepare(&sql)
        .and_then(|mut stmt| stmt.query_map([&sub.account_id, &sub.key.value], candidate)?.collect())
        .unwrap_or_default();
    let is_gmail = crate::rules::is_gmail_account(conn, &sub.account_id);
    let mut moved = 0;
    for mail in mails {
        if !matches(&sub.key.kind, &sub.key.value, sub.blocked, &mail.facts()) || protected_from_cleanup(conn, &mail.id, correspondents) {
            continue;
        }
        if crate::rules::trash_mail(conn, &sub.account_id, &mail.id, &mail.message_id, &mail.folder_path, is_gmail) {
            moved += 1;
        }
    }
    moved
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{seed_account, seed_folder, seed_mail, temp_db, SeedMail};
    use crate::unsubscribe::key::{KeyKind, ListKey};
    use crate::unsubscribe::store::{get, insert_block, insert_request};
    use chrono::{DateTime, Utc};
    use rusqlite::Connection;

    const LIST: &str = r#"{"list-id":"<wr.halde-shop.example>"}"#;
    const UNSUB: &str = "<https://news.halde-shop.example/u>";
    const AFTER: &str = "2026-10-10T09:00:00Z";

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn t0() -> DateTime<Utc> {
        at("2026-10-01T08:00:00Z")
    }

    fn list_key() -> ListKey {
        ListKey { kind: KeyKind::ListId, value: "wr.halde-shop.example".into() }
    }

    struct Fx {
        db: crate::db::Database,
        account: String,
        inbox: String,
        trash: String,
    }

    fn fx() -> Fx {
        let db = temp_db();
        let (account, inbox, trash) = {
            let conn = db.lock_db();
            let account = seed_account(&conn, "me@studio-halde.example");
            let inbox = seed_folder(&conn, &account, "inbox");
            let trash = seed_folder(&conn, &account, "trash");
            (account, inbox, trash)
        };
        Fx { db, account, inbox, trash }
    }

    fn list_mail<'a>(f: &'a Fx, date: &'a str) -> SeedMail<'a> {
        SeedMail {
            account_id: &f.account,
            folder_id: &f.inbox,
            from_email: "news@halde-shop.example",
            subject: "Wochenrückblick",
            list_unsubscribe: UNSUB,
            signal_headers: LIST,
            date,
            ..Default::default()
        }
    }

    fn folder(conn: &Connection, mail: &str) -> String {
        conn.query_row("SELECT folder_id FROM mails WHERE id = ?1", [mail], |r| r.get(0)).unwrap()
    }

    fn unsubscribe(f: &Fx) -> String {
        insert_request(&f.db.lock_db(), &f.account, &list_key(), "Halde Shop", "one_click", false, t0()).unwrap().id
    }

    fn sorted(f: &Fx, id: &str) -> u32 {
        get(&f.db.lock_db(), id).unwrap().unwrap().sorted_count
    }

    #[test]
    fn list_mail_after_grace_goes_to_trash() {
        let f = fx();
        let sub = unsubscribe(&f);
        let mail = seed_mail(&f.db.lock_db(), &list_mail(&f, AFTER));
        let rest = sweep_new_mails(&f.account, &[mail.clone()], &f.db);
        assert!(rest.is_empty());
        let conn = f.db.lock_db();
        assert_eq!(folder(&conn, &mail), f.trash);
        let ops: u32 = conn
            .query_row("SELECT COUNT(*) FROM pending_ops WHERE mail_id = ?1 AND op_type = 'trash'", [&mail], |r| r.get(0))
            .unwrap();
        assert_eq!(ops, 1);
        drop(conn);
        assert_eq!(sorted(&f, &sub), 1);
    }

    #[test]
    fn mail_inside_grace_stays() {
        let f = fx();
        unsubscribe(&f);
        let mail = seed_mail(&f.db.lock_db(), &list_mail(&f, "2026-10-02T09:00:00Z"));
        assert_eq!(sweep_new_mails(&f.account, &[mail.clone()], &f.db), vec![mail.clone()]);
        assert_eq!(folder(&f.db.lock_db(), &mail), f.inbox);
    }

    #[test]
    fn undated_mail_stays() {
        let f = fx();
        unsubscribe(&f);
        let mail = seed_mail(&f.db.lock_db(), &list_mail(&f, "kaputt"));
        assert_eq!(sweep_new_mails(&f.account, &[mail.clone()], &f.db), vec![mail]);
    }

    #[test]
    fn purchases_and_personal_mails_are_spared() {
        let f = fx();
        unsubscribe(&f);
        let conn = f.db.lock_db();
        let receipt = seed_mail(&conn, &SeedMail { category: Some("purchases"), ..list_mail(&f, AFTER) });
        conn.execute(
            "INSERT INTO sender_categories (email, category, created_at) VALUES ('anna.weber@halde-shop.example', 'important', '2026-01-02 03:04:05')",
            [],
        )
        .unwrap();
        let personal = seed_mail(&conn, &SeedMail { from_email: "anna.weber@halde-shop.example", ..list_mail(&f, AFTER) });
        drop(conn);
        let ids = vec![receipt.clone(), personal.clone()];
        assert_eq!(sweep_new_mails(&f.account, &ids, &f.db), ids);
    }

    #[test]
    fn fresh_order_confirmation_from_unsubscribed_sender_is_spared() {
        let f = fx();
        unsubscribe(&f);
        let mail = seed_mail(&f.db.lock_db(), &SeedMail { subject: "Deine Bestellung 4711 ist unterwegs", ..list_mail(&f, AFTER) });
        assert_eq!(sweep_new_mails(&f.account, &[mail.clone()], &f.db), vec![mail]);
    }

    #[test]
    fn spam_folder_hit_is_counted_not_moved() {
        let f = fx();
        let sub = unsubscribe(&f);
        let spam = seed_folder(&f.db.lock_db(), &f.account, "spam");
        let mail = seed_mail(&f.db.lock_db(), &SeedMail { folder_id: &spam, ..list_mail(&f, AFTER) });
        sweep_new_mails(&f.account, &[mail.clone()], &f.db);
        assert_eq!(folder(&f.db.lock_db(), &mail), spam);
        assert_eq!(sorted(&f, &sub), 1);
    }

    #[test]
    fn blocked_sender_mail_goes_regardless_of_bulk() {
        let f = fx();
        let key = ListKey { kind: KeyKind::Sender, value: "gewinn@spam-halde.example".into() };
        insert_block(&f.db.lock_db(), &f.account, &key, "Gewinnspiel", t0()).unwrap();
        let mail = seed_mail(
            &f.db.lock_db(),
            &SeedMail { account_id: &f.account, folder_id: &f.inbox, from_email: "gewinn@spam-halde.example", subject: "Du hast gewonnen", date: AFTER, ..Default::default() },
        );
        assert!(sweep_new_mails(&f.account, &[mail.clone()], &f.db).is_empty());
        assert_eq!(folder(&f.db.lock_db(), &mail), f.trash);
    }

    #[test]
    fn entry_only_sweeps_its_own_account() {
        let f = fx();
        unsubscribe(&f);
        let conn = f.db.lock_db();
        let other = seed_account(&conn, "anna.weber@studio-halde.example");
        let other_inbox = seed_folder(&conn, &other, "inbox");
        seed_folder(&conn, &other, "trash");
        let elsewhere = ListKey { kind: KeyKind::ListId, value: "forum.studio-halde.example".into() };
        insert_request(&conn, &other, &elsewhere, "Forum", "mailto", false, t0()).unwrap();
        let mail = seed_mail(&conn, &SeedMail { account_id: &other, folder_id: &other_inbox, ..list_mail(&f, AFTER) });
        drop(conn);
        assert_eq!(sweep_new_mails(&other, &[mail.clone()], &f.db), vec![mail]);
    }

    #[test]
    fn foreign_mail_id_is_ignored() {
        let f = fx();
        unsubscribe(&f);
        let conn = f.db.lock_db();
        let other = seed_account(&conn, "anna.weber@studio-halde.example");
        let other_inbox = seed_folder(&conn, &other, "inbox");
        let mail = seed_mail(&conn, &SeedMail { account_id: &other, folder_id: &other_inbox, ..list_mail(&f, AFTER) });
        drop(conn);
        sweep_new_mails(&f.account, &[mail.clone()], &f.db);
        assert_eq!(folder(&f.db.lock_db(), &mail), other_inbox);
    }

    #[test]
    fn late_synced_mail_from_before_retry_does_not_mark_sending() {
        let f = fx();
        let sub = unsubscribe(&f);
        crate::unsubscribe::store::record_retry(&f.db.lock_db(), &sub, "mailto", false, at("2026-10-06T08:00:00Z")).unwrap();
        let mail = seed_mail(&f.db.lock_db(), &list_mail(&f, "2026-10-05T09:00:00Z"));
        sweep_new_mails(&f.account, &[mail], &f.db);
        let sub = get(&f.db.lock_db(), &sub).unwrap().unwrap();
        assert_eq!(sub.sorted_count, 1);
        assert_eq!(crate::unsubscribe::store::status(&sub, at("2026-10-10T08:00:00Z")), "quiet");
    }

    #[test]
    fn list_id_case_differences_still_match() {
        let f = fx();
        unsubscribe(&f);
        let mail = seed_mail(&f.db.lock_db(), &SeedMail { signal_headers: r#"{"list-id":"Rückblick <WR.Halde-Shop.example>"}"#, ..list_mail(&f, AFTER) });
        assert!(sweep_new_mails(&f.account, &[mail.clone()], &f.db).is_empty());
        assert_eq!(folder(&f.db.lock_db(), &mail), f.trash);
    }

    #[test]
    fn swept_mail_is_not_handed_to_rules() {
        let f = fx();
        unsubscribe(&f);
        let conn = f.db.lock_db();
        let newsletters = seed_folder(&conn, &f.account, "custom");
        conn.execute(
            "INSERT INTO mail_rules (id, account_id, name, from_contains, action_move_to_folder) VALUES ('r1', ?1, 'Newsletter', 'halde-shop', ?2)",
            rusqlite::params![f.account, newsletters],
        )
        .unwrap();
        let mail = seed_mail(&conn, &list_mail(&f, AFTER));
        drop(conn);
        let rest = sweep_new_mails(&f.account, &[mail.clone()], &f.db);
        crate::rules::apply_rules_to_mails(&f.account, &rest, &f.db);
        assert_eq!(folder(&f.db.lock_db(), &mail), f.trash);
    }

    #[test]
    fn local_folder_mail_is_left_alone() {
        let f = fx();
        let sub_id = unsubscribe(&f);
        let conn = f.db.lock_db();
        let local = seed_folder(&conn, &f.account, "custom");
        conn.execute("UPDATE folders SET is_local = 1 WHERE id = ?1", [&local]).unwrap();
        let kept = seed_mail(&conn, &SeedMail { folder_id: &local, ..list_mail(&f, "2026-09-01T09:00:00Z") });
        seed_mail(&conn, &list_mail(&f, "2026-09-02T09:00:00Z"));
        let sub = get(&conn, &sub_id).unwrap().unwrap();
        assert_eq!(trash_existing(&conn, &sub, &std::collections::HashMap::new()), 1);
        assert_eq!(folder(&conn, &kept), local);
    }

    #[test]
    fn spared_list_mail_after_grace_still_counts_as_sending() {
        let f = fx();
        let sub = unsubscribe(&f);
        let mail = seed_mail(&f.db.lock_db(), &SeedMail { category: Some("purchases"), ..list_mail(&f, AFTER) });
        sweep_new_mails(&f.account, &[mail], &f.db);
        let sub = get(&f.db.lock_db(), &sub).unwrap().unwrap();
        assert_eq!(crate::unsubscribe::store::status(&sub, chrono::Utc::now()), "still_sending");
        assert_eq!(sub.sorted_count, 0);
    }

    #[test]
    fn trash_clears_uid_so_trash_rows_never_collide() {
        let f = fx();
        unsubscribe(&f);
        let conn = f.db.lock_db();
        let old = seed_mail(&conn, &SeedMail { folder_id: &f.trash, ..list_mail(&f, "2026-09-01T09:00:00Z") });
        let mail = seed_mail(&conn, &list_mail(&f, AFTER));
        conn.execute("UPDATE mails SET uid = 5 WHERE id IN (?1, ?2)", [&old, &mail]).unwrap();
        conn.execute("UPDATE folders SET total_count = 1, unread_count = 1 WHERE id = ?1", [&f.inbox]).unwrap();
        drop(conn);
        assert!(sweep_new_mails(&f.account, &[mail.clone()], &f.db).is_empty());
        let conn = f.db.lock_db();
        assert_eq!(folder(&conn, &mail), f.trash);
        let uid: Option<u32> = conn.query_row("SELECT uid FROM mails WHERE id = ?1", [&mail], |r| r.get(0)).unwrap();
        assert_eq!(uid, None);
        let payload: String = conn.query_row("SELECT payload FROM pending_ops WHERE mail_id = ?1", [&mail], |r| r.get(0)).unwrap();
        assert_eq!(serde_json::from_str::<serde_json::Value>(&payload).unwrap()["uid"], 5);
        let counts: (u32, u32) = conn
            .query_row("SELECT total_count, unread_count FROM folders WHERE id = ?1", [&f.inbox], |r| Ok((r.get(0)?, r.get(1)?)))
            .unwrap();
        assert_eq!(counts, (0, 0));
    }

    #[test]
    fn security_mails_are_spared() {
        let f = fx();
        unsubscribe(&f);
        let mail = seed_mail(&f.db.lock_db(), &SeedMail { subject: "Dein Bestätigungscode: 482913", ..list_mail(&f, AFTER) });
        assert_eq!(sweep_new_mails(&f.account, &[mail.clone()], &f.db), vec![mail]);
    }

    #[test]
    fn trash_existing_moves_only_matching_mails() {
        let f = fx();
        let sub_id = unsubscribe(&f);
        let conn = f.db.lock_db();
        for date in ["2026-09-01T09:00:00Z", "2026-09-08T09:00:00Z", "2026-09-15T09:00:00Z"] {
            seed_mail(&conn, &list_mail(&f, date));
        }
        let receipt = seed_mail(
            &conn,
            &SeedMail { account_id: &f.account, folder_id: &f.inbox, from_email: "news@halde-shop.example", subject: "Rechnung", date: "2026-09-20T09:00:00Z", ..Default::default() },
        );
        let sub = get(&conn, &sub_id).unwrap().unwrap();
        assert_eq!(trash_existing(&conn, &sub, &std::collections::HashMap::new()), 3);
        assert_eq!(folder(&conn, &receipt), f.inbox);
    }
}
