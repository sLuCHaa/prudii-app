use crate::categorize::signals::HeaderSignals;
use crate::commands::unsubscribe::{can_retry, list_status, retry_left, Offer};
use crate::db::Database;
use crate::trackers::store::{stamp, DEFAULT_DAYS};
use crate::unsubscribe::key::{list_key, sender_key, KeyKind, ListKey, MailFacts};
use crate::unsubscribe::store::{self as unsub_store, UnsubscriptionView};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use tauri::State;

#[derive(Debug, Serialize)]
pub struct NewsletterRow {
    pub account_id: String,
    pub key: String,
    pub name: String,
    pub address: String,
    pub count: u32,
    pub read: u32,
    pub last_received: String,
    pub trackers: u32,
    pub sample_mail_id: String,
    pub offer: Offer,
    pub subscription: Option<UnsubscriptionView>,
}

#[derive(Debug, Serialize)]
pub struct NewsletterOverview {
    pub rows: Vec<NewsletterRow>,
    pub mails: u32,
    pub unsubscribed: u32,
    pub blocked: u32,
}

struct Candidate {
    id: String,
    account_id: String,
    from_email: String,
    signal_headers: String,
    list_unsubscribe: String,
    category: Option<String>,
    date: String,
    is_read: bool,
    message: String,
}

struct Group {
    key: ListKey,
    messages: HashSet<String>,
    read: HashSet<String>,
    mail_ids: Vec<String>,
    newest_id: String,
    newest_date: String,
    address: String,
    // The newest mail that can be unsubscribed from keeps a list's action stable when its latest copy lacks the header.
    newest_unsub: Option<Sample>,
}

struct Sample {
    date: String,
    id: String,
    signal_headers: String,
    list_unsubscribe: String,
}

fn row_key(account: &str, key: &ListKey) -> String {
    format!("{account}|{}:{}", key.kind.as_str(), key.value)
}

fn group_key(c: &Candidate, sorting_enabled: bool) -> Option<ListKey> {
    let facts = MailFacts { from_email: &c.from_email, signal_headers: &c.signal_headers, list_unsubscribe: &c.list_unsubscribe };
    if HeaderSignals::parse(&c.signal_headers, &c.list_unsubscribe).is_bulk() {
        return list_key(&facts);
    }
    let newsletter = matches!(c.category.as_deref(), Some("newsletters" | "promotions"));
    if sorting_enabled && newsletter { sender_key(&c.from_email) } else { None }
}

fn load_candidates(conn: &Connection, cutoff: &str, account_id: Option<&str>) -> Result<Vec<Candidate>, String> {
    // SQL narrows to plausible list mail; group_key decides with the same rules as the unsubscribe safety net.
    let sql = "SELECT m.id, m.account_id, COALESCE(m.from_email, ''), COALESCE(m.signal_headers, ''), COALESCE(m.list_unsubscribe, ''),
                      m.category, m.date, m.is_read, COALESCE(NULLIF(m.message_id, ''), m.id)
               FROM mails m JOIN folders f ON m.folder_id = f.id
               WHERE m.date >= ?1 AND m.date GLOB '[0-9][0-9][0-9][0-9]-*' AND (?2 IS NULL OR m.account_id = ?2)
                 AND f.folder_type NOT IN ('trash', 'spam') AND COALESCE(m.category, '') NOT IN ('important', 'purchases')
                 AND (COALESCE(m.list_unsubscribe, '') != '' OR m.signal_headers LIKE '%list-id%' OR m.signal_headers LIKE '%precedence%'
                      OR m.signal_headers LIKE '%x-csa-complaints%' OR m.category IN ('newsletters', 'promotions'))";
    conn.prepare(sql)
        .and_then(|mut stmt| {
            stmt.query_map(params![cutoff, account_id], |r| {
                Ok(Candidate {
                    id: r.get(0)?,
                    account_id: r.get(1)?,
                    from_email: r.get(2)?,
                    signal_headers: r.get(3)?,
                    list_unsubscribe: r.get(4)?,
                    category: r.get(5)?,
                    date: r.get(6)?,
                    is_read: r.get::<_, i32>(7)? != 0,
                    message: r.get(8)?,
                })
            })?
            .collect()
        })
        .map_err(|e| e.to_string())
}

pub(crate) fn newsletter_overview(
    conn: &Connection,
    cutoff: &str,
    account_id: Option<&str>,
    sorting_enabled: bool,
    now: DateTime<Utc>,
) -> Result<NewsletterOverview, String> {
    let mut groups: HashMap<String, (String, Group)> = HashMap::new();
    for c in load_candidates(conn, cutoff, account_id)? {
        let Some(key) = group_key(&c, sorting_enabled) else { continue };
        let (_, group) = groups.entry(row_key(&c.account_id, &key)).or_insert_with(|| {
            (
                c.account_id.clone(),
                Group {
                    key,
                    messages: HashSet::new(),
                    read: HashSet::new(),
                    mail_ids: Vec::new(),
                    newest_id: String::new(),
                    newest_date: String::new(),
                    address: String::new(),
                    newest_unsub: None,
                },
            )
        });
        if c.is_read {
            group.read.insert(c.message.clone());
        }
        group.messages.insert(c.message);
        if c.date > group.newest_date {
            group.newest_date = c.date.clone();
            group.newest_id = c.id.clone();
            group.address = c.from_email.to_lowercase();
        }
        if !c.list_unsubscribe.trim().is_empty() && group.newest_unsub.as_ref().is_none_or(|s| c.date > s.date) {
            group.newest_unsub = Some(Sample {
                date: c.date.clone(),
                id: c.id.clone(),
                signal_headers: c.signal_headers.clone(),
                list_unsubscribe: c.list_unsubscribe.clone(),
            });
        }
        group.mail_ids.push(c.id);
    }

    let tracker_counts: HashMap<String, u32> = conn
        .prepare(
            "SELECT h.mail_id, SUM(h.count) FROM mail_tracker_hits h JOIN mails m ON m.id = h.mail_id
             WHERE m.date >= ?1 AND (?2 IS NULL OR m.account_id = ?2) GROUP BY h.mail_id",
        )
        .and_then(|mut stmt| stmt.query_map(params![cutoff, account_id], |r| Ok((r.get(0)?, r.get(1)?)))?.collect())
        .map_err(|e| e.to_string())?;

    let view = |sub: &unsub_store::Unsubscription| unsub_store::view(sub, now, can_retry(conn, sub, now));
    let mut mails = 0;
    let mut rows = Vec::with_capacity(groups.len());
    for (row_key, (account, group)) in &groups {
        let sample = group.newest_unsub.as_ref().map(|s| s.id.clone()).unwrap_or_else(|| group.newest_id.clone());
        let status = list_status(conn, &sample, now)?;
        let count = group.messages.len() as u32;
        mails += count;
        rows.push(NewsletterRow {
            key: row_key.clone(),
            account_id: account.clone(),
            name: status.name,
            address: group.address.clone(),
            count,
            read: group.read.len() as u32,
            last_received: group.newest_date.clone(),
            trackers: group.mail_ids.iter().filter_map(|id| tracker_counts.get(id)).sum(),
            sample_mail_id: sample,
            // Every row is list mail, so a list without a usable header can still be kept out.
            offer: if status.offer == Offer::None { Offer::Block } else { status.offer },
            subscription: unsub_store::find(conn, account, &group.key).map_err(|e| e.to_string())?.map(|sub| match &group.newest_unsub {
                Some(s) => unsub_store::view(&sub, now, retry_left(&sub, &s.signal_headers, &s.list_unsubscribe, now)),
                None => view(&sub),
            }),
        });
    }

    // Unsubscribing usually trashes the list's mail; its entry must stay reachable here.
    let entries = unsub_store::list(conn, account_id).map_err(|e| e.to_string())?;
    for sub in entries.iter().filter(|sub| !groups.contains_key(&row_key(&sub.account_id, &sub.key))) {
        rows.push(NewsletterRow {
            key: row_key(&sub.account_id, &sub.key),
            account_id: sub.account_id.clone(),
            name: sub.display_name.clone(),
            address: if sub.key.kind == KeyKind::Sender { sub.key.value.clone() } else { String::new() },
            count: 0,
            read: 0,
            last_received: String::new(),
            trackers: 0,
            sample_mail_id: String::new(),
            offer: Offer::None,
            subscription: Some(view(sub)),
        });
    }
    rows.sort_by(|a, b| {
        b.count.cmp(&a.count).then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase())).then_with(|| a.key.cmp(&b.key))
    });

    let unsubscribed = entries.iter().filter(|s| !s.blocked).count() as u32;
    let blocked = entries.iter().filter(|s| s.blocked).count() as u32;
    Ok(NewsletterOverview { rows, mails, unsubscribed, blocked })
}

#[tauri::command(async)]
pub fn get_newsletter_overview(db: State<'_, Database>, account_id: Option<String>) -> Result<NewsletterOverview, String> {
    let conn = db.read_db();
    let sorting_enabled = conn
        .query_row("SELECT value FROM app_settings WHERE key = 'sorting_enabled'", [], |r| r.get::<_, String>(0))
        .map(|v| v == "true" || v == "1")
        .unwrap_or(true);
    let now = Utc::now();
    let cutoff = stamp(now - Duration::days(DEFAULT_DAYS as i64));
    newsletter_overview(&conn, &cutoff, account_id.as_deref(), sorting_enabled, now)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{seed_account, seed_folder, seed_mail, temp_db, SeedMail};
    use crate::trackers::store::{record, TrackerHit, TrackerRecord};
    use crate::unsubscribe::key::{KeyKind, ListKey};
    use crate::unsubscribe::store::insert_request;

    const CUTOFF: &str = "2026-10-01T00:00:00Z";
    const LIST: &str = r#"{"list-id":"Wochenrückblick <wr.halde-shop.example>"}"#;
    const UNSUB: &str = "<https://news.halde-shop.example/u>";

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn now() -> DateTime<Utc> {
        at("2026-10-20T08:00:00Z")
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
            seed_folder(&conn, &account, "trash");
            (account, inbox)
        };
        Fx { db, account, inbox }
    }

    struct M<'a> {
        account: &'a str,
        folder: &'a str,
        from: &'a str,
        headers: &'a str,
        unsub: &'a str,
        category: Option<&'a str>,
        date: &'a str,
        read: bool,
        message_id: &'a str,
    }

    fn base<'a>(f: &'a Fx, message_id: &'a str) -> M<'a> {
        M { account: &f.account, folder: &f.inbox, from: "news@halde-shop.example", headers: LIST, unsub: UNSUB, category: None, date: "2026-10-10T09:00:00Z", read: false, message_id }
    }

    fn put(f: &Fx, m: M) -> String {
        let conn = f.db.lock_db();
        let id = seed_mail(
            &conn,
            &SeedMail {
                account_id: m.account,
                folder_id: m.folder,
                from_email: m.from,
                signal_headers: m.headers,
                list_unsubscribe: m.unsub,
                category: m.category,
                date: m.date,
                ..Default::default()
            },
        );
        conn.execute("UPDATE mails SET is_read = ?1, message_id = ?2 WHERE id = ?3", rusqlite::params![m.read as i32, m.message_id, id]).unwrap();
        id
    }

    fn overview(f: &Fx, account: Option<&str>, sorting: bool) -> NewsletterOverview {
        newsletter_overview(&f.db.lock_db(), CUTOFF, account, sorting, now()).unwrap()
    }

    #[test]
    fn overview_groups_by_list_and_counts_reads() {
        let f = fx();
        put(&f, M { read: true, ..base(&f, "a") });
        put(&f, M { read: true, date: "2026-10-11T09:00:00Z", ..base(&f, "b") });
        put(&f, M { date: "2026-10-12T09:00:00Z", ..base(&f, "c") });
        put(&f, M { from: "deals@laden-halde.example", headers: "{}", ..base(&f, "d") });
        let o = overview(&f, None, true);
        assert_eq!(o.rows.len(), 2);
        assert_eq!((o.rows[0].count, o.rows[0].read), (3, 2));
        assert_eq!(o.rows[0].name, "Wochenrückblick");
        assert_eq!(o.rows[0].offer, Offer::Unsubscribe);
        assert_eq!(o.rows[0].last_received, "2026-10-12T09:00:00Z");
        assert_eq!(o.mails, 4);
    }

    #[test]
    fn label_copies_count_once_in_the_overview() {
        let f = fx();
        put(&f, base(&f, "msg-1"));
        let label = seed_folder(&f.db.lock_db(), &f.account, "custom");
        put(&f, M { folder: &label, ..base(&f, "msg-1") });
        assert_eq!(overview(&f, None, true).rows[0].count, 1);
    }

    #[test]
    fn category_only_mail_offers_block_and_needs_sorting() {
        let f = fx();
        put(&f, M { from: "angebote@laden-halde.example", headers: "{}", unsub: "", category: Some("newsletters"), ..base(&f, "x") });
        let o = overview(&f, None, true);
        assert_eq!(o.rows.len(), 1);
        assert_eq!(o.rows[0].offer, Offer::Block);
        assert!(overview(&f, None, false).rows.is_empty());
    }

    #[test]
    fn spared_categories_and_trash_are_left_out() {
        let f = fx();
        let trash: String = f.db.lock_db().query_row("SELECT id FROM folders WHERE folder_type = 'trash'", [], |r| r.get(0)).unwrap();
        let spam = seed_folder(&f.db.lock_db(), &f.account, "spam");
        put(&f, M { category: Some("purchases"), ..base(&f, "p") });
        put(&f, M { folder: &trash, ..base(&f, "t") });
        put(&f, M { folder: &spam, ..base(&f, "s") });
        put(&f, M { date: "2026-09-20T09:00:00Z", ..base(&f, "old") });
        assert!(overview(&f, None, true).rows.is_empty());
    }

    #[test]
    fn row_carries_status_and_trackers() {
        let f = fx();
        let a = put(&f, base(&f, "a"));
        let b = put(&f, M { date: "2026-10-11T09:00:00Z", ..base(&f, "b") });
        let key = ListKey { kind: KeyKind::ListId, value: "wr.halde-shop.example".into() };
        let conn = f.db.lock_db();
        insert_request(&conn, &f.account, &key, "Wochenrückblick", "one_click", false, at("2026-10-19T08:00:00Z")).unwrap();
        let hit = |n| TrackerHit { kind: "pixel".into(), domain: "open.halde-shop.example".into(), company: None, count: n };
        record(&conn, &TrackerRecord { mail_id: a, hits: vec![hit(2)] }, now()).unwrap();
        record(&conn, &TrackerRecord { mail_id: b, hits: vec![hit(3)] }, now()).unwrap();
        drop(conn);
        let row = &overview(&f, None, true).rows[0];
        assert_eq!(row.trackers, 5);
        assert_eq!(row.subscription.as_ref().unwrap().status, "waiting");
    }

    #[test]
    fn unsubscribed_list_stays_in_the_overview() {
        let f = fx();
        let trash: String = f.db.lock_db().query_row("SELECT id FROM folders WHERE folder_type = 'trash'", [], |r| r.get(0)).unwrap();
        put(&f, M { folder: &trash, ..base(&f, "a") });
        let key = ListKey { kind: KeyKind::ListId, value: "wr.halde-shop.example".into() };
        insert_request(&f.db.lock_db(), &f.account, &key, "Wochenrückblick", "one_click", false, at("2026-10-19T08:00:00Z")).unwrap();
        let o = overview(&f, None, true);
        assert_eq!(o.rows.len(), 1);
        assert_eq!(o.rows[0].name, "Wochenrückblick");
        assert_eq!(o.rows[0].count, 0);
        assert_eq!(o.rows[0].subscription.as_ref().unwrap().status, "waiting");
    }

    #[test]
    fn status_follows_the_group_key() {
        let f = fx();
        put(&f, M { date: "2026-10-09T09:00:00Z", ..base(&f, "with-header") });
        put(&f, M { unsub: "", date: "2026-10-12T09:00:00Z", ..base(&f, "without-header") });
        let key = ListKey { kind: KeyKind::ListId, value: "wr.halde-shop.example".into() };
        insert_request(&f.db.lock_db(), &f.account, &key, "Wochenrückblick", "mailto", false, at("2026-10-19T08:00:00Z")).unwrap();
        let o = overview(&f, None, true);
        assert_eq!(o.rows.len(), 1);
        assert!(o.rows[0].subscription.is_some());
        assert_eq!(o.rows[0].offer, Offer::Unsubscribe);
    }

    #[test]
    fn bulk_rows_without_header_offer_block() {
        let f = fx();
        put(&f, M { headers: r#"{"precedence":"bulk"}"#, unsub: "", ..base(&f, "bulk") });
        let o = overview(&f, None, true);
        assert_eq!(o.rows.len(), 1);
        assert_eq!(o.rows[0].offer, Offer::Block);
    }

    #[test]
    fn still_sending_row_offers_retry_from_its_sample() {
        let f = fx();
        let one_click = r#"{"list-id":"<wr.halde-shop.example>","list-unsubscribe-post":"List-Unsubscribe=One-Click"}"#;
        put(&f, M { headers: one_click, unsub: "<https://news.halde-shop.example/u>, <mailto:unsub@halde-shop.example>", ..base(&f, "a") });
        let key = ListKey { kind: KeyKind::ListId, value: "wr.halde-shop.example".into() };
        let conn = f.db.lock_db();
        let sub = insert_request(&conn, &f.account, &key, "Wochenrückblick", "one_click", false, at("2026-10-01T08:00:00Z")).unwrap();
        crate::unsubscribe::store::record_sorted(&conn, &sub.id, at("2026-10-08T08:00:00Z")).unwrap();
        drop(conn);
        let view = overview(&f, None, true).rows[0].subscription.clone().unwrap();
        assert_eq!(view.status, "still_sending");
        assert!(view.can_retry);
    }

    #[test]
    fn important_mail_is_left_out() {
        let f = fx();
        put(&f, M { category: Some("important"), ..base(&f, "i") });
        assert!(overview(&f, None, true).rows.is_empty());
    }

    #[test]
    fn account_filter_limits_rows_and_tiles() {
        let f = fx();
        let (other, other_inbox) = {
            let conn = f.db.lock_db();
            let other = seed_account(&conn, "anna.weber@studio-halde.example");
            let inbox = seed_folder(&conn, &other, "inbox");
            (other, inbox)
        };
        put(&f, base(&f, "a"));
        put(&f, M { account: &other, folder: &other_inbox, from: "news@forum-halde.example", headers: r#"{"list-id":"<forum.halde.example>"}"#, ..base(&f, "b") });
        let conn = f.db.lock_db();
        let key = |v: &str| ListKey { kind: KeyKind::ListId, value: v.into() };
        insert_request(&conn, &f.account, &key("wr.halde-shop.example"), "Wochenrückblick", "mailto", false, now()).unwrap();
        insert_request(&conn, &other, &key("forum.halde.example"), "Forum", "mailto", false, now()).unwrap();
        drop(conn);
        let o = overview(&f, Some(&other), true);
        assert_eq!(o.rows.len(), 1);
        assert_eq!(o.rows[0].account_id, other);
        assert_eq!((o.unsubscribed, o.blocked), (1, 0));
        assert_eq!(overview(&f, None, true).unsubscribed, 2);
    }
}
