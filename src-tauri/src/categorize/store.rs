use super::heuristics::{classify, MailInput};
use super::signals::HeaderSignals;
use super::{Decision, Reason};
use crate::db::Database;
use rusqlite::{params, Connection};
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
                    COALESCE(m.list_unsubscribe, ''), m.thread_id
             FROM mails m JOIN folders f ON m.folder_id = f.id
             WHERE f.folder_type = 'inbox' AND m.category IS NULL LIMIT ?1",
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

pub fn categorize_all_pending(db: &Database) -> usize {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return 0;
    }
    let _guard = RunGuard;

    let correspondents = load_correspondents(&db.lock_db());
    let mut total = 0;
    loop {
        let conn = db.lock_db();
        match categorize_batch(&conn, &correspondents, BATCH) {
            Ok(0) => break,
            Ok(n) => total += n,
            Err(e) => {
                log::error!("categorize batch failed: {e}");
                break;
            }
        }
    }
    total
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
    fn concurrent_call_returns_immediately() {
        let _serial = SERIAL.lock().unwrap_or_else(|e| e.into_inner());
        let f = fixture();
        let id = seed_mail(&f.db.lock_db(), &pending(&f, "info@studio-halde.example"));
        set_running(true);
        assert_eq!(categorize_all_pending(&f.db), 0);
        set_running(false);
        assert_eq!(row(&f.db.lock_db(), &id).0, None);
    }
}
