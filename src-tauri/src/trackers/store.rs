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

pub const DEFAULT_DAYS: u32 = 30;
const TOP: usize = 10;

#[derive(Debug, Default, Serialize)]
pub struct KindCounts {
    pub pixel: u32,
    pub hidden: u32,
    pub tracking_domain: u32,
}

#[derive(Debug, Serialize)]
pub struct CompanyCount {
    pub name: String,
    pub known: bool,
    pub count: u32,
}

#[derive(Debug, Serialize)]
pub struct SenderCount {
    pub name: String,
    pub address: String,
    pub count: u32,
    pub mails: u32,
}

#[derive(Debug, Serialize)]
pub struct TrackerReport {
    pub days: u32,
    pub scanned_mails: u32,
    pub mails_with_trackers: u32,
    pub total: u32,
    pub by_kind: KindCounts,
    pub companies: Vec<CompanyCount>,
    pub senders: Vec<SenderCount>,
}

// A broken date would sort after any digit and land in every window.
const WINDOW_SQL: &str = "m.date >= ?1 AND m.date GLOB '[0-9][0-9][0-9][0-9]-*' AND (?2 IS NULL OR m.account_id = ?2)";

fn top<T>(mut items: Vec<T>, count: impl Fn(&T) -> u32, name: impl Fn(&T) -> &str) -> Vec<T> {
    items.sort_by(|a, b| count(b).cmp(&count(a)).then_with(|| name(a).cmp(name(b))));
    items.truncate(TOP);
    items
}

pub fn report(conn: &Connection, cutoff: &str, account_id: Option<&str>, days: u32) -> rusqlite::Result<TrackerReport> {
    let scanned_mails: u32 = conn.query_row(
        &format!("SELECT COUNT(*) FROM mail_tracker_scans s JOIN mails m ON m.id = s.mail_id WHERE {WINDOW_SQL}"),
        params![cutoff, account_id],
        |r| r.get(0),
    )?;
    let rows: Vec<(String, String, String, u32, String, String, String, String)> = conn
        .prepare(&format!(
            "SELECT h.kind, h.domain, h.company, h.count, m.id, lower(COALESCE(m.from_email, '')), COALESCE(m.from_name, ''), m.date
             FROM mail_tracker_hits h JOIN mails m ON m.id = h.mail_id WHERE {WINDOW_SQL}"
        ))?
        .query_map(params![cutoff, account_id], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?, r.get(4)?, r.get(5)?, r.get(6)?, r.get(7)?))
        })?
        .collect::<rusqlite::Result<_>>()?;

    let mut by_kind = KindCounts::default();
    let mut total = 0;
    let mut mails = std::collections::HashSet::new();
    let mut companies: std::collections::HashMap<(String, bool), u32> = std::collections::HashMap::new();
    // address -> (count, mail ids, newest date with a name, that name)
    let mut senders: std::collections::HashMap<String, (u32, std::collections::HashSet<String>, String, String)> = std::collections::HashMap::new();
    for (kind, domain, company, count, mail_id, address, name, date) in rows {
        total += count;
        match kind.as_str() {
            "pixel" => by_kind.pixel += count,
            "hidden" => by_kind.hidden += count,
            _ => by_kind.tracking_domain += count,
        }
        mails.insert(mail_id.clone());
        let key = if company.is_empty() { (domain, false) } else { (company, true) };
        *companies.entry(key).or_default() += count;
        let entry = senders.entry(address).or_default();
        entry.0 += count;
        entry.1.insert(mail_id);
        if !name.trim().is_empty() && date > entry.2 {
            entry.2 = date;
            entry.3 = name;
        }
    }

    let companies = top(
        companies.into_iter().map(|((name, known), count)| CompanyCount { name, known, count }).collect(),
        |c| c.count,
        |c| c.name.as_str(),
    );
    let senders = top(
        senders
            .into_iter()
            .map(|(address, (count, ids, _, name))| SenderCount {
                name: if name.is_empty() { address.clone() } else { name },
                address,
                count,
                mails: ids.len() as u32,
            })
            .collect(),
        |s| s.count,
        |s| s.address.as_str(),
    );
    Ok(TrackerReport { days, scanned_mails, mails_with_trackers: mails.len() as u32, total, by_kind, companies, senders })
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

    fn scanned(f: &Fx, account: &str, from: &str, name: &str, date: &str, msg: &str, hits: Vec<TrackerHit>) {
        let conn = f.db.lock_db();
        let folder: String = conn.query_row("SELECT id FROM folders WHERE account_id = ?1 LIMIT 1", [account], |r| r.get(0)).unwrap();
        let id = seed_mail(&conn, &SeedMail { account_id: account, folder_id: &folder, from_email: from, list_unsubscribe: UNSUB, date, ..Default::default() });
        conn.execute("UPDATE mails SET message_id = ?1, from_name = ?2 WHERE id = ?3", [msg, name, &id]).unwrap();
        assert!(record(&conn, &TrackerRecord { mail_id: id, hits }, now()).unwrap());
    }

    #[test]
    fn report_sums_kinds_companies_and_senders() {
        let f = fx();
        let account = f.account.clone();
        scanned(&f, &account, "news@halde-shop.example", "Halde Shop", "2026-10-10T09:00:00Z", "a",
            vec![hit("tracking_domain", "list-manage.com", Some("Mailchimp"), 3), hit("pixel", "open.halde-shop.example", None, 1)]);
        scanned(&f, &account, "News@Halde-Shop.example", "Halde Shop", "2026-10-12T09:00:00Z", "b",
            vec![hit("tracking_domain", "mcsv.net", Some("Mailchimp"), 1)]);
        scanned(&f, &account, "anna.weber@studio-halde.example", "Anna Weber", "2026-10-13T09:00:00Z", "c", vec![]);
        let r = report(&f.db.lock_db(), CUTOFF, None, 30).unwrap();
        assert_eq!((r.total, r.scanned_mails, r.mails_with_trackers), (5, 3, 2));
        assert_eq!((r.by_kind.tracking_domain, r.by_kind.pixel, r.by_kind.hidden), (4, 1, 0));
        assert_eq!((r.companies[0].name.as_str(), r.companies[0].known, r.companies[0].count), ("Mailchimp", true, 4));
        assert_eq!((r.companies[1].name.as_str(), r.companies[1].known, r.companies[1].count), ("open.halde-shop.example", false, 1));
        assert_eq!(r.senders.len(), 1);
        assert_eq!((r.senders[0].name.as_str(), r.senders[0].address.as_str()), ("Halde Shop", "news@halde-shop.example"));
        assert_eq!((r.senders[0].count, r.senders[0].mails), (5, 2));
    }

    #[test]
    fn report_counts_only_the_window() {
        let f = fx();
        let account = f.account.clone();
        scanned(&f, &account, "news@halde-shop.example", "", "2026-09-20T09:00:00Z", "old", vec![hit("pixel", "open.halde-shop.example", None, 1)]);
        scanned(&f, &account, "news@halde-shop.example", "", "kaputt", "broken", vec![hit("pixel", "open.halde-shop.example", None, 1)]);
        scanned(&f, &account, "news@halde-shop.example", "", "2026-10-10T09:00:00Z", "new", vec![hit("pixel", "open.halde-shop.example", None, 2)]);
        let r = report(&f.db.lock_db(), CUTOFF, None, 30).unwrap();
        assert_eq!((r.total, r.scanned_mails), (2, 1));
        assert_eq!(r.senders[0].name, "news@halde-shop.example");
    }

    #[test]
    fn report_filters_by_account() {
        let f = fx();
        let account = f.account.clone();
        let other = {
            let conn = f.db.lock_db();
            let other = seed_account(&conn, "anna.weber@studio-halde.example");
            seed_folder(&conn, &other, "inbox");
            other
        };
        scanned(&f, &account, "news@halde-shop.example", "", "2026-10-10T09:00:00Z", "a", vec![hit("pixel", "open.halde-shop.example", None, 1)]);
        scanned(&f, &other, "news@halde-shop.example", "", "2026-10-10T09:00:00Z", "b", vec![hit("pixel", "open.halde-shop.example", None, 4)]);
        assert_eq!(report(&f.db.lock_db(), CUTOFF, Some(&other), 30).unwrap().total, 4);
        assert_eq!(report(&f.db.lock_db(), CUTOFF, None, 30).unwrap().total, 5);
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
