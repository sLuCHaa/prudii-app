use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

pub const KINDS: [&str; 3] = ["pixel", "hidden", "tracking_domain"];

/// Same idea of a newsletter as the unsubscribe safety net, plus what sorting labelled as one.
pub(crate) const BULK_SQL: &str = "(COALESCE(m.list_unsubscribe, '') != '' OR m.category IN ('newsletters', 'promotions'))";

// Gmail keeps one row per label; a message counts once, whichever row was shown.
const SCANNED_SQL: &str = "EXISTS (SELECT 1 FROM mail_tracker_scans s JOIN mails o ON o.id = s.mail_id
     WHERE s.mail_id = m.id OR (COALESCE(m.message_id, '') != '' AND o.account_id = m.account_id AND o.message_id = m.message_id))";

#[derive(Debug, Clone, Deserialize)]
pub struct TrackerHit {
    pub kind: String,
    pub domain: String,
    pub company: Option<String>,
    pub count: u32,
}

#[derive(Debug, Clone, Deserialize)]
pub struct TrackerRecord {
    pub mail_id: String,
    pub hits: Vec<TrackerHit>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StoredBody {
    pub mail_id: String,
    pub html: String,
}

pub fn stamp(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Returns false when the message was already counted or the mail is gone.
pub fn record(conn: &Connection, rec: &TrackerRecord, now: DateTime<Utc>) -> rusqlite::Result<bool> {
    let fresh: bool = conn.query_row(
        &format!("SELECT NOT {SCANNED_SQL} FROM mails m WHERE m.id = ?1"),
        params![rec.mail_id],
        |r| r.get(0),
    )
    .unwrap_or(false);
    if !fresh {
        return Ok(false);
    }
    let tx = conn.unchecked_transaction()?;
    tx.execute("INSERT INTO mail_tracker_scans (mail_id, scanned_at) VALUES (?1, ?2)", params![rec.mail_id, stamp(now)])?;
    for hit in rec.hits.iter().filter(|h| KINDS.contains(&h.kind.as_str()) && h.count > 0 && !h.domain.trim().is_empty()) {
        tx.execute(
            "INSERT INTO mail_tracker_hits (mail_id, kind, domain, company, count) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(mail_id, kind, domain) DO UPDATE SET count = count + excluded.count",
            params![rec.mail_id, hit.kind, hit.domain.trim().to_lowercase(), hit.company.as_deref().unwrap_or("").trim(), hit.count],
        )?;
    }
    tx.commit()?;
    Ok(true)
}

pub fn unscanned_bodies(conn: &Connection, cutoff: &str, limit: u32) -> rusqlite::Result<Vec<StoredBody>> {
    conn.prepare(&format!(
        "SELECT m.id, m.body_html FROM mails m
         WHERE {BULK_SQL} AND m.date >= ?1 AND COALESCE(m.body_html, '') != '' AND NOT {SCANNED_SQL}
         ORDER BY m.date DESC LIMIT ?2"
    ))?
    .query_map(params![cutoff, limit], |r| Ok(StoredBody { mail_id: r.get(0)?, html: r.get(1)? }))?
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{seed_account, seed_folder, seed_mail, temp_db, SeedMail};

    const UNSUB: &str = "<https://news.halde-shop.example/u>";
    const CUTOFF: &str = "2026-10-01T00:00:00Z";

    fn now() -> DateTime<Utc> {
        DateTime::parse_from_rfc3339("2026-10-20T08:00:00Z").unwrap().with_timezone(&Utc)
    }

    struct Fx {
        db: crate::db::Database,
        account: String,
        inbox: String,
    }

    fn fx() -> Fx {
        let db = temp_db();
        let (account, inbox) = {
            let conn = db.lock_db();
            let account = seed_account(&conn, "me@studio-halde.example");
            let inbox = seed_folder(&conn, &account, "inbox");
            (account, inbox)
        };
        Fx { db, account, inbox }
    }

    fn list_mail(f: &Fx, date: &str, message_id: &str, body: &str) -> String {
        let conn = f.db.lock_db();
        let id = seed_mail(
            &conn,
            &SeedMail { account_id: &f.account, folder_id: &f.inbox, from_email: "news@halde-shop.example", list_unsubscribe: UNSUB, date, ..Default::default() },
        );
        conn.execute("UPDATE mails SET message_id = ?1, body_html = ?2 WHERE id = ?3", [message_id, body, &id]).unwrap();
        id
    }

    fn hit(kind: &str, domain: &str, company: Option<&str>, count: u32) -> TrackerHit {
        TrackerHit { kind: kind.into(), domain: domain.into(), company: company.map(str::to_string), count }
    }

    fn count(f: &Fx, table: &str) -> u32 {
        f.db.lock_db().query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |r| r.get(0)).unwrap()
    }

    #[test]
    fn record_stores_hits_and_a_scan() {
        let f = fx();
        let id = list_mail(&f, "2026-10-10T09:00:00Z", "<a@halde-shop.example>", "<p>Hallo</p>");
        let rec = TrackerRecord {
            mail_id: id,
            hits: vec![hit("pixel", "open.halde-shop.example", None, 1), hit("tracking_domain", "list-manage.com", Some("Mailchimp"), 2)],
        };
        assert!(record(&f.db.lock_db(), &rec, now()).unwrap());
        assert_eq!(count(&f, "mail_tracker_hits"), 2);
        assert_eq!(count(&f, "mail_tracker_scans"), 1);
    }

    #[test]
    fn label_copies_count_once() {
        let f = fx();
        let first = list_mail(&f, "2026-10-10T09:00:00Z", "msg-1", "<p>Hallo</p>");
        let conn = f.db.lock_db();
        let label = seed_folder(&conn, &f.account, "custom");
        let copy = seed_mail(
            &conn,
            &SeedMail { account_id: &f.account, folder_id: &label, from_email: "news@halde-shop.example", list_unsubscribe: UNSUB, date: "2026-10-10T09:00:00Z", ..Default::default() },
        );
        conn.execute("UPDATE mails SET message_id = 'msg-1' WHERE id = ?1", [&copy]).unwrap();
        assert!(record(&conn, &TrackerRecord { mail_id: first, hits: vec![hit("pixel", "open.halde-shop.example", None, 1)] }, now()).unwrap());
        assert!(!record(&conn, &TrackerRecord { mail_id: copy, hits: vec![hit("pixel", "open.halde-shop.example", None, 1)] }, now()).unwrap());
        drop(conn);
        assert_eq!(count(&f, "mail_tracker_scans"), 1);
        assert_eq!(count(&f, "mail_tracker_hits"), 1);
    }

    #[test]
    fn mail_without_trackers_is_still_marked_scanned() {
        let f = fx();
        let id = list_mail(&f, "2026-10-10T09:00:00Z", "msg-1", "<p>Hallo</p>");
        assert!(record(&f.db.lock_db(), &TrackerRecord { mail_id: id, hits: vec![] }, now()).unwrap());
        assert_eq!(count(&f, "mail_tracker_scans"), 1);
        assert_eq!(count(&f, "mail_tracker_hits"), 0);
    }

    #[test]
    fn unknown_kinds_and_empty_hits_are_dropped() {
        let f = fx();
        let id = list_mail(&f, "2026-10-10T09:00:00Z", "msg-1", "<p>Hallo</p>");
        let rec = TrackerRecord { mail_id: id, hits: vec![hit("font", "fonts.halde-shop.example", None, 1), hit("pixel", "open.halde-shop.example", None, 0)] };
        assert!(record(&f.db.lock_db(), &rec, now()).unwrap());
        assert_eq!(count(&f, "mail_tracker_hits"), 0);
    }

    #[test]
    fn hits_go_with_their_mail() {
        let f = fx();
        let id = list_mail(&f, "2026-10-10T09:00:00Z", "msg-1", "<p>Hallo</p>");
        record(&f.db.lock_db(), &TrackerRecord { mail_id: id.clone(), hits: vec![hit("pixel", "open.halde-shop.example", None, 1)] }, now()).unwrap();
        f.db.lock_db().execute("DELETE FROM mails WHERE id = ?1", [&id]).unwrap();
        assert_eq!(count(&f, "mail_tracker_hits"), 0);
        assert_eq!(count(&f, "mail_tracker_scans"), 0);
    }

    #[test]
    fn scanned_mails_are_not_listed_again() {
        let f = fx();
        let scanned = list_mail(&f, "2026-10-12T09:00:00Z", "msg-1", "<p>1</p>");
        let newer = list_mail(&f, "2026-10-15T09:00:00Z", "msg-2", "<p>2</p>");
        let older = list_mail(&f, "2026-10-11T09:00:00Z", "msg-3", "<p>3</p>");
        list_mail(&f, "2026-10-13T09:00:00Z", "msg-4", "");
        list_mail(&f, "2026-09-20T09:00:00Z", "msg-5", "<p>alt</p>");
        let conn = f.db.lock_db();
        let personal = seed_mail(&conn, &SeedMail { account_id: &f.account, folder_id: &f.inbox, from_email: "anna.weber@studio-halde.example", date: "2026-10-14T09:00:00Z", ..Default::default() });
        conn.execute("UPDATE mails SET body_html = '<p>Hallo</p>' WHERE id = ?1", [&personal]).unwrap();
        record(&conn, &TrackerRecord { mail_id: scanned, hits: vec![] }, now()).unwrap();
        let ids: Vec<String> = unscanned_bodies(&conn, CUTOFF, 10).unwrap().into_iter().map(|b| b.mail_id).collect();
        assert_eq!(ids, vec![newer, older]);
    }
}
