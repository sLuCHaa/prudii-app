use super::heuristics::{classify, MailInput};
use super::signals::HeaderSignals;
use super::{Decision, Reason, BUILTIN_CATEGORIES};
use crate::db::Database;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicBool, Ordering};

pub const BATCH: usize = 500;

static RUNNING: AtomicBool = AtomicBool::new(false);

struct RunGuard;

impl Drop for RunGuard {
    fn drop(&mut self) {
        RUNNING.store(false, Ordering::SeqCst);
    }
}

fn addresses(json: &str) -> Vec<String> {
    serde_json::from_str::<Vec<serde_json::Value>>(json)
        .unwrap_or_default()
        .iter()
        .filter_map(|v| v.get("email").and_then(|e| e.as_str()))
        .map(|e| e.trim().to_lowercase())
        .filter(|e| !e.is_empty())
        .collect()
}

pub fn load_correspondents(conn: &Connection) -> HashMap<String, u32> {
    let own: HashSet<String> = conn
        .prepare("SELECT lower(email) FROM accounts")
        .and_then(|mut s| s.query_map([], |r| r.get::<_, String>(0))?.collect::<Result<_, _>>())
        .unwrap_or_default();

    let mut counts: HashMap<String, u32> = HashMap::new();
    let rows = conn
        .prepare(
            "SELECT m.to_json, COALESCE(m.cc_json, '[]') FROM mails m
             JOIN folders f ON m.folder_id = f.id WHERE f.folder_type = 'sent'",
        )
        .and_then(|mut s| s.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?.collect::<Result<Vec<_>, _>>());
    for (to, cc) in rows.unwrap_or_default() {
        let mut seen: HashSet<String> = addresses(&to).into_iter().collect();
        seen.extend(addresses(&cc));
        for addr in seen {
            if !own.contains(&addr) {
                *counts.entry(addr).or_insert(0) += 1;
            }
        }
    }
    counts
}

struct Pending {
    id: String,
    account_id: String,
    from_name: String,
    from_email: String,
    subject: String,
    signal_headers: String,
    list_unsubscribe: String,
    thread_id: Option<String>,
}

fn decide(conn: &Connection, mail: &Pending, correspondents: &HashMap<String, u32>) -> rusqlite::Result<Decision> {
    let sender = mail.from_email.trim().to_lowercase();

    if !sender.is_empty() {
        let rule: Option<String> = conn
            .prepare_cached("SELECT category FROM sender_categories WHERE email = ?1")?
            .query_row(params![sender], |r| r.get(0))
            .ok();
        if let Some(category) = rule {
            return Ok(Decision {
                category: (!category.is_empty()).then_some(category),
                source: "sender",
                confidence: 1.0,
                reasons: vec![Reason::new("sender_rule").with("sender", &sender)],
            });
        }
    }

    if let Some(thread) = mail.thread_id.as_deref().filter(|t| !t.is_empty()) {
        let inherited: Option<String> = conn
            .prepare_cached(
                "SELECT category FROM mails WHERE account_id = ?1 AND thread_id = ?2 AND id != ?3
                 AND category_source = 'user' AND category IS NOT NULL ORDER BY date DESC LIMIT 1",
            )?
            .query_row(params![mail.account_id, thread, mail.id], |r| r.get(0))
            .ok();
        if let Some(category) = inherited {
            return Ok(Decision {
                category: (!category.is_empty()).then_some(category),
                source: "thread",
                confidence: 1.0,
                reasons: vec![Reason::new("thread_rule")],
            });
        }
    }

    let signals = HeaderSignals::parse(&mail.signal_headers, &mail.list_unsubscribe);
    Ok(classify(&MailInput {
        from_name: &mail.from_name,
        from_email: &mail.from_email,
        subject: &mail.subject,
        signals: &signals,
        sent_count: correspondents.get(&sender).copied().unwrap_or(0),
    }))
}

pub fn categorize_batch(conn: &Connection, correspondents: &HashMap<String, u32>, limit: usize) -> rusqlite::Result<usize> {
    let pending: Vec<Pending> = conn
        .prepare(
            "SELECT m.id, m.account_id, COALESCE(m.from_email, ''), COALESCE(m.subject, ''), COALESCE(m.signal_headers, ''),
                    COALESCE(m.list_unsubscribe, ''), m.thread_id, COALESCE(m.from_name, '')
             FROM mails m JOIN folders f ON m.folder_id = f.id
             WHERE f.folder_type = 'inbox' AND m.category IS NULL ORDER BY m.date DESC LIMIT ?1",
        )?
        .query_map(params![limit as i64], |r| {
            Ok(Pending {
                id: r.get(0)?,
                account_id: r.get(1)?,
                from_email: r.get(2)?,
                subject: r.get(3)?,
                signal_headers: r.get(4)?,
                list_unsubscribe: r.get(5)?,
                thread_id: r.get(6)?,
                from_name: r.get(7)?,
            })
        })?
        .collect::<Result<_, _>>()?;

    let tx = conn.unchecked_transaction()?;
    for mail in &pending {
        let decision = decide(&tx, mail, correspondents)?;
        let reasons = serde_json::to_string(&decision.reasons).unwrap_or_else(|_| "[]".into());
        tx.prepare_cached(
            "UPDATE mails SET category = ?1, category_source = ?2, category_confidence = ?3, category_reasons = ?4 WHERE id = ?5",
        )?
        .execute(params![decision.category.as_deref().unwrap_or(""), decision.source, decision.confidence, reasons, mail.id])?;
    }
    tx.commit()?;
    Ok(pending.len())
}

fn has_pending(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM mails m JOIN folders f ON m.folder_id = f.id
         WHERE f.folder_type = 'inbox' AND m.category IS NULL)",
        [],
        |r| r.get::<_, bool>(0),
    )
    .unwrap_or(true)
}

pub fn categorize_all_pending(db: &Database) -> usize {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return 0;
    }
    let _guard = RunGuard;

    let correspondents = {
        let conn = db.lock_db();
        if !has_pending(&conn) {
            return 0;
        }
        load_correspondents(&conn)
    };
    let mut total = 0;
    loop {
        let result = categorize_batch(&db.lock_db(), &correspondents, BATCH);
        match result {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) => {
                log::error!("categorize batch failed: {e}");
                break;
            }
        }
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    total
}

#[derive(Serialize)]
pub struct MailCategoryInfo {
    pub category: Option<String>,
    pub source: Option<String>,
    pub reasons: Vec<Reason>,
    pub sender: String,
    pub sender_rule: Option<String>,
}

#[derive(Serialize)]
pub struct CategoryCount {
    pub folder_id: String,
    pub category: String,
    pub unread: u32,
    pub total: u32,
}

#[derive(Serialize)]
pub struct SenderRule {
    pub email: String,
    pub category: String,
    pub created_at: String,
}

fn reasons_json(reasons: &[Reason]) -> String {
    serde_json::to_string(reasons).unwrap_or_else(|_| "[]".into())
}

pub fn set_mail_category(conn: &Connection, mail_id: &str, category: Option<&str>, remember_sender: bool) -> Result<usize, String> {
    if let Some(c) = category {
        if !BUILTIN_CATEGORIES.contains(&c) {
            return Err(format!("unknown category: {c}"));
        }
    }
    let value = category.unwrap_or("");
    let err = |e: rusqlite::Error| e.to_string();

    let sender: String = conn
        .query_row("SELECT lower(trim(COALESCE(from_email, ''))) FROM mails WHERE id = ?1", params![mail_id], |r| r.get(0))
        .map_err(err)?;

    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut changed = tx
        .execute(
            "UPDATE mails SET category = ?1, category_source = 'user', category_confidence = 1.0, category_reasons = ?2 WHERE id = ?3",
            params![value, reasons_json(&[Reason::new("user_choice")]), mail_id],
        )
        .map_err(err)?;

    if remember_sender && !sender.is_empty() {
        tx.execute("INSERT OR REPLACE INTO sender_categories (email, category) VALUES (?1, ?2)", params![sender, value]).map_err(err)?;
        changed += tx
            .execute(
                "UPDATE mails SET category = ?1, category_source = 'sender', category_confidence = 1.0, category_reasons = ?2
                 WHERE lower(trim(from_email)) = ?3 AND id != ?4 AND COALESCE(category_source, '') != 'user'
                   AND folder_id IN (SELECT id FROM folders WHERE folder_type = 'inbox')",
                params![value, reasons_json(&[Reason::new("sender_rule").with("sender", &sender)]), sender, mail_id],
            )
            .map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(changed)
}

pub fn category_info(conn: &Connection, mail_id: &str) -> rusqlite::Result<Option<MailCategoryInfo>> {
    let row = conn.query_row(
        "SELECT category, category_source, category_reasons, COALESCE(from_email, '') FROM mails WHERE id = ?1",
        params![mail_id],
        |r| Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?, r.get::<_, Option<String>>(2)?, r.get::<_, String>(3)?)),
    );
    let (category, source, reasons, from_email) = match row {
        Ok(v) => v,
        Err(rusqlite::Error::QueryReturnedNoRows) => return Ok(None),
        Err(e) => return Err(e),
    };
    let sender = from_email.trim().to_lowercase();
    let sender_rule = conn
        .query_row("SELECT category FROM sender_categories WHERE email = ?1", params![sender], |r| r.get::<_, String>(0))
        .ok();
    Ok(Some(MailCategoryInfo {
        category,
        source,
        reasons: reasons.and_then(|j| serde_json::from_str(&j).ok()).unwrap_or_default(),
        sender,
        sender_rule,
    }))
}

pub fn category_counts(conn: &Connection) -> rusqlite::Result<Vec<CategoryCount>> {
    conn.prepare(
        "SELECT m.folder_id, m.category, SUM(CASE WHEN m.is_read = 0 THEN 1 ELSE 0 END), COUNT(*)
         FROM mails m JOIN folders f ON m.folder_id = f.id
         WHERE f.folder_type = 'inbox' AND m.category IS NOT NULL AND m.category != ''
           AND (m.snoozed_until IS NULL OR m.snoozed_until = '' OR m.snoozed_until <= datetime('now'))
         GROUP BY m.folder_id, m.category ORDER BY m.folder_id, m.category",
    )?
    .query_map([], |r| Ok(CategoryCount { folder_id: r.get(0)?, category: r.get(1)?, unread: r.get(2)?, total: r.get(3)? }))?
    .collect()
}

pub fn list_sender_rules(conn: &Connection) -> rusqlite::Result<Vec<SenderRule>> {
    conn.prepare("SELECT email, category, created_at FROM sender_categories ORDER BY email")?
        .query_map([], |r| Ok(SenderRule { email: r.get(0)?, category: r.get(1)?, created_at: r.get(2)? }))?
        .collect()
}

pub fn delete_sender_rule(conn: &Connection, email: &str) -> rusqlite::Result<()> {
    let email = email.trim().to_lowercase();
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM sender_categories WHERE email = ?1", params![email])?;
    tx.execute(
        "UPDATE mails SET category = NULL, category_source = NULL, category_confidence = NULL, category_reasons = NULL
         WHERE lower(trim(from_email)) = ?1 AND category_source = 'sender'",
        params![email],
    )?;
    tx.commit()
}

pub fn reset_all(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM sender_categories", [])?;
    tx.execute(
        "UPDATE mails SET category = NULL, category_source = NULL, category_confidence = NULL, category_reasons = NULL
         WHERE category IS NOT NULL OR category_source IS NOT NULL",
        [],
    )?;
    tx.commit()
}

#[cfg(test)]
fn set_running(value: bool) {
    RUNNING.store(value, Ordering::SeqCst);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::*;
    use std::sync::Mutex;

    static SERIAL: Mutex<()> = Mutex::new(());

    struct Fixture {
        db: Database,
        account: String,
        inbox: String,
    }

    fn fixture() -> Fixture {
        let db = temp_db();
        let (account, inbox) = {
            let conn = db.lock_db();
            let account = seed_account(&conn, "me@studio-halde.example");
            let inbox = seed_folder(&conn, &account, "inbox");
            (account, inbox)
        };
        Fixture { db, account, inbox }
    }

    fn pending<'a>(f: &'a Fixture, from: &'a str) -> SeedMail<'a> {
        SeedMail { account_id: &f.account, folder_id: &f.inbox, from_email: from, subject: "Hallo", ..Default::default() }
    }

    fn row(conn: &Connection, id: &str) -> (Option<String>, Option<String>, Option<String>) {
        conn.query_row("SELECT category, category_source, category_reasons FROM mails WHERE id = ?1", params![id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?))
        })
        .unwrap()
    }

    #[test]
    fn only_pending_inbox_mails_are_processed() {
        let f = fixture();
        let conn = f.db.lock_db();
        let archive = seed_folder(&conn, &f.account, "archive");
        let a = seed_mail(&conn, &pending(&f, "anna.weber@studio-halde.example"));
        let b = seed_mail(&conn, &SeedMail { category: Some("social"), ..pending(&f, "anna.weber@studio-halde.example") });
        let c = seed_mail(&conn, &SeedMail { folder_id: &archive, ..pending(&f, "anna.weber@studio-halde.example") });

        assert_eq!(categorize_batch(&conn, &HashMap::new(), BATCH).unwrap(), 1);
        assert!(row(&conn, &a).0.is_some());
        assert_eq!(row(&conn, &b).0.as_deref(), Some("social"));
        assert_eq!(row(&conn, &c).0, None);
    }

    #[test]
    fn sent_mail_makes_sender_important() {
        let f = fixture();
        let conn = f.db.lock_db();
        let sent = seed_folder(&conn, &f.account, "sent");
        seed_mail(
            &conn,
            &SeedMail {
                folder_id: &sent,
                from_email: "me@studio-halde.example",
                to_json: r#"[{"name":"Anna Weber","email":"Anna.Weber@studio-halde.example"}]"#,
                ..pending(&f, "")
            },
        );
        let id = seed_mail(&conn, &pending(&f, "anna.weber@studio-halde.example"));

        let correspondents = load_correspondents(&conn);
        categorize_batch(&conn, &correspondents, BATCH).unwrap();
        let (category, source, reasons) = row(&conn, &id);
        assert_eq!(category.as_deref(), Some("important"));
        assert_eq!(source.as_deref(), Some("relation"));
        assert!(reasons.unwrap().contains(r#""count":"1""#));
    }

    #[test]
    fn own_address_is_no_correspondent() {
        let f = fixture();
        let conn = f.db.lock_db();
        let sent = seed_folder(&conn, &f.account, "sent");
        seed_mail(
            &conn,
            &SeedMail { folder_id: &sent, to_json: r#"[{"name":"Ich","email":"me@studio-halde.example"}]"#, ..pending(&f, "") },
        );
        assert!(!load_correspondents(&conn).contains_key("me@studio-halde.example"));
    }

    #[test]
    fn sender_rule_wins_over_heuristics() {
        let f = fixture();
        let conn = f.db.lock_db();
        conn.execute("INSERT INTO sender_categories VALUES ('news@designweekly.example','important', datetime('now'))", []).unwrap();
        let id = seed_mail(
            &conn,
            &SeedMail { signal_headers: r#"{"list-id":"weekly.designweekly.example"}"#, ..pending(&f, "News@DesignWeekly.example") },
        );
        categorize_batch(&conn, &HashMap::new(), BATCH).unwrap();
        let (category, source, _) = row(&conn, &id);
        assert_eq!(category.as_deref(), Some("important"));
        assert_eq!(source.as_deref(), Some("sender"));
    }

    #[test]
    fn user_thread_choice_is_inherited() {
        let f = fixture();
        let conn = f.db.lock_db();
        seed_mail(
            &conn,
            &SeedMail { thread_id: Some("t1"), category: Some("purchases"), category_source: Some("user"), ..pending(&f, "anna.weber@studio-halde.example") },
        );
        let id = seed_mail(&conn, &SeedMail { thread_id: Some("t1"), ..pending(&f, "anna.weber@studio-halde.example") });
        categorize_batch(&conn, &HashMap::new(), BATCH).unwrap();
        let (category, source, _) = row(&conn, &id);
        assert_eq!(category.as_deref(), Some("purchases"));
        assert_eq!(source.as_deref(), Some("thread"));
    }

    #[test]
    fn unsure_mail_is_marked_processed() {
        let f = fixture();
        let conn = f.db.lock_db();
        let id = seed_mail(&conn, &pending(&f, "info@studio-halde.example"));
        categorize_batch(&conn, &HashMap::new(), BATCH).unwrap();
        let (category, _, reasons) = row(&conn, &id);
        assert_eq!(category.as_deref(), Some(""));
        assert!(reasons.unwrap().contains("low_confidence"));
    }

    #[test]
    fn broken_sender_is_processed() {
        let f = fixture();
        let conn = f.db.lock_db();
        let empty = seed_mail(&conn, &pending(&f, ""));
        let short = seed_mail(&conn, &pending(&f, "anna"));
        categorize_batch(&conn, &HashMap::new(), BATCH).unwrap();
        assert_eq!(row(&conn, &empty).0.as_deref(), Some(""));
        assert_eq!(row(&conn, &short).0.as_deref(), Some(""));
    }

    #[test]
    fn all_pending_runs_in_batches() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        set_running(false);
        let f = fixture();
        {
            let conn = f.db.lock_db();
            conn.execute_batch("BEGIN").unwrap();
            for _ in 0..1201 {
                seed_mail(&conn, &pending(&f, "info@studio-halde.example"));
            }
            conn.execute_batch("COMMIT").unwrap();
        }
        assert_eq!(categorize_all_pending(&f.db), 1201);
        let left: i64 = f.db.lock_db().query_row("SELECT COUNT(*) FROM mails WHERE category IS NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }

    #[test]
    fn nothing_pending_returns_zero() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        set_running(false);
        let f = fixture();
        seed_mail(&f.db.lock_db(), &SeedMail { category: Some(""), ..pending(&f, "info@studio-halde.example") });
        assert_eq!(categorize_all_pending(&f.db), 0);
        assert_eq!(categorize_all_pending(&f.db), 0);
    }

    #[test]
    fn pending_mails_are_processed_newest_first() {
        let f = fixture();
        let conn = f.db.lock_db();
        let old = seed_mail(&conn, &pending(&f, "info@studio-halde.example"));
        let new = seed_mail(&conn, &pending(&f, "info@studio-halde.example"));
        conn.execute("UPDATE mails SET date = '2020-01-01T00:00:00Z' WHERE id = ?1", params![old]).unwrap();
        conn.execute("UPDATE mails SET date = '2026-01-01T00:00:00Z' WHERE id = ?1", params![new]).unwrap();
        assert_eq!(categorize_batch(&conn, &HashMap::new(), 1).unwrap(), 1);
        assert!(row(&conn, &new).0.is_some());
        assert_eq!(row(&conn, &old).0, None);
    }

    #[test]
    fn concurrent_call_returns_immediately() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let f = fixture();
        let id = seed_mail(&f.db.lock_db(), &pending(&f, "info@studio-halde.example"));
        set_running(true);
        assert_eq!(categorize_all_pending(&f.db), 0);
        set_running(false);
        assert_eq!(row(&f.db.lock_db(), &id).0, None);
    }

    fn cat_source(conn: &Connection, id: &str) -> (Option<String>, Option<String>) {
        let r = row(conn, id);
        (r.0, r.1)
    }

    #[test]
    fn correction_sets_user_source() {
        let f = fixture();
        let conn = f.db.lock_db();
        let a = seed_mail(&conn, &pending(&f, "anna.weber@studio-halde.example"));
        let b = seed_mail(&conn, &pending(&f, "anna.weber@studio-halde.example"));
        assert_eq!(set_mail_category(&conn, &a, Some("newsletters"), false).unwrap(), 1);
        assert_eq!(cat_source(&conn, &a), (Some("newsletters".into()), Some("user".into())));
        assert_eq!(cat_source(&conn, &b), (None, None));
    }

    #[test]
    fn remember_sender_is_case_insensitive() {
        let f = fixture();
        let conn = f.db.lock_db();
        let first = seed_mail(&conn, &pending(&f, "Anna.Weber@Studio-Halde.example"));
        let user = seed_mail(
            &conn,
            &SeedMail { category: Some("social"), category_source: Some("user"), ..pending(&f, "anna.weber@studio-halde.example") },
        );
        categorize_batch(&conn, &HashMap::new(), BATCH).unwrap();
        assert_eq!(row(&conn, &first).0.as_deref(), Some("important"));

        set_mail_category(&conn, &first, Some("purchases"), true).unwrap();
        let rules = list_sender_rules(&conn).unwrap();
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].email, "anna.weber@studio-halde.example");
        assert_eq!(row(&conn, &user).0.as_deref(), Some("social"));

        let next = seed_mail(&conn, &pending(&f, "ANNA.WEBER@studio-halde.example"));
        categorize_batch(&conn, &HashMap::new(), BATCH).unwrap();
        assert_eq!(cat_source(&conn, &next), (Some("purchases".into()), Some("sender".into())));
    }

    #[test]
    fn remember_sender_only_relabels_inbox_mails() {
        let f = fixture();
        let conn = f.db.lock_db();
        let archive = seed_folder(&conn, &f.account, "archive");
        let a = seed_mail(&conn, &pending(&f, "anna.weber@studio-halde.example"));
        let inbox_other = seed_mail(&conn, &pending(&f, "anna.weber@studio-halde.example"));
        let archived = seed_mail(&conn, &SeedMail { folder_id: &archive, ..pending(&f, "anna.weber@studio-halde.example") });
        let changed = set_mail_category(&conn, &a, Some("purchases"), true).unwrap();
        assert_eq!(changed, 2);
        assert_eq!(row(&conn, &inbox_other).0.as_deref(), Some("purchases"));
        assert_eq!(row(&conn, &archived).0, None);
    }

    #[test]
    fn remember_none_is_stored_as_empty() {
        let f = fixture();
        let conn = f.db.lock_db();
        let id = seed_mail(&conn, &pending(&f, "anna.weber@studio-halde.example"));
        set_mail_category(&conn, &id, None, true).unwrap();
        assert_eq!(list_sender_rules(&conn).unwrap()[0].category, "");
        assert_eq!(category_info(&conn, &id).unwrap().unwrap().sender_rule, Some(String::new()));
    }

    #[test]
    fn unknown_category_is_rejected() {
        let f = fixture();
        let conn = f.db.lock_db();
        let id = seed_mail(&conn, &pending(&f, "anna.weber@studio-halde.example"));
        assert!(set_mail_category(&conn, &id, Some("steuern"), false).is_err());
    }

    #[test]
    fn counts_cover_inbox_categories() {
        let f = fixture();
        let conn = f.db.lock_db();
        let archive = seed_folder(&conn, &f.account, "archive");
        let news = SeedMail { category: Some("newsletters"), ..pending(&f, "news@designweekly.example") };
        seed_mail(&conn, &news);
        seed_mail(&conn, &news);
        let read = seed_mail(&conn, &news);
        conn.execute("UPDATE mails SET is_read = 1 WHERE id = ?1", params![read]).unwrap();
        seed_mail(&conn, &SeedMail { folder_id: &archive, ..news });
        seed_mail(&conn, &SeedMail { category: Some(""), ..pending(&f, "info@studio-halde.example") });

        let counts = category_counts(&conn).unwrap();
        assert_eq!(counts.len(), 1);
        assert_eq!((counts[0].category.as_str(), counts[0].unread, counts[0].total), ("newsletters", 2, 3));
        assert_eq!(counts[0].folder_id, f.inbox);
    }

    #[test]
    fn deleting_rule_requeues_sender_mails() {
        let f = fixture();
        let conn = f.db.lock_db();
        let a = seed_mail(&conn, &pending(&f, "anna.weber@studio-halde.example"));
        let b = seed_mail(&conn, &pending(&f, "anna.weber@studio-halde.example"));
        let user = seed_mail(
            &conn,
            &SeedMail { category: Some("social"), category_source: Some("user"), ..pending(&f, "anna.weber@studio-halde.example") },
        );
        set_mail_category(&conn, &a, Some("purchases"), true).unwrap();
        assert_eq!(row(&conn, &b).1.as_deref(), Some("sender"));

        delete_sender_rule(&conn, "Anna.Weber@studio-halde.example").unwrap();
        assert_eq!(row(&conn, &b).0, None);
        assert_eq!(row(&conn, &user).0.as_deref(), Some("social"));
        assert!(list_sender_rules(&conn).unwrap().is_empty());
    }

    #[test]
    fn reset_clears_everything() {
        let f = fixture();
        let conn = f.db.lock_db();
        let a = seed_mail(&conn, &pending(&f, "anna.weber@studio-halde.example"));
        seed_mail(&conn, &SeedMail { category: Some("social"), category_source: Some("user"), ..pending(&f, "x@studio-halde.example") });
        set_mail_category(&conn, &a, Some("purchases"), true).unwrap();
        reset_all(&conn).unwrap();
        assert!(list_sender_rules(&conn).unwrap().is_empty());
        let left: i64 = conn.query_row("SELECT COUNT(*) FROM mails WHERE category IS NOT NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(left, 0);
    }
}
