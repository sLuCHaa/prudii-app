use super::key::{KeyKind, ListKey};
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;

pub const GRACE_DAYS: i64 = 3;

#[derive(Debug, Clone)]
pub struct Unsubscription {
    pub id: String,
    pub account_id: String,
    pub key: ListKey,
    pub display_name: String,
    pub blocked: bool,
    pub methods_tried: Vec<String>,
    pub web_pending: bool,
    pub requested_at: DateTime<Utc>,
    pub last_request_at: DateTime<Utc>,
    pub sweep_after: DateTime<Utc>,
    pub sorted_count: u32,
    pub last_sorted_at: Option<DateTime<Utc>>,
    pub last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UnsubscriptionView {
    pub id: String,
    pub display_name: String,
    pub status: &'static str,
    pub requested_at: String,
    pub web_pending: bool,
    pub quiet_days: u32,
    pub sorted_count: u32,
    pub can_retry: bool,
}

const COLUMNS: &str = "id, account_id, key_kind, key_value, display_name, blocked, methods_tried, web_pending, requested_at, last_request_at, sweep_after, sorted_count, last_sorted_at, last_seen_at";

pub fn stamp(t: DateTime<Utc>) -> String {
    t.format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

pub fn parse_stamp(s: &str) -> Option<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s.trim()).ok().map(|t| t.with_timezone(&Utc))
}

fn bad_text(idx: usize, raw: String) -> rusqlite::Error {
    rusqlite::Error::InvalidColumnType(idx, raw, rusqlite::types::Type::Text)
}

fn time_col(row: &Row, idx: usize) -> rusqlite::Result<DateTime<Utc>> {
    let raw: String = row.get(idx)?;
    parse_stamp(&raw).ok_or_else(|| bad_text(idx, raw))
}

fn from_row(row: &Row) -> rusqlite::Result<Unsubscription> {
    let kind: String = row.get(2)?;
    let methods: String = row.get(6)?;
    Ok(Unsubscription {
        id: row.get(0)?,
        account_id: row.get(1)?,
        key: ListKey { kind: KeyKind::parse(&kind).ok_or_else(|| bad_text(2, kind.clone()))?, value: row.get(3)? },
        display_name: row.get(4)?,
        blocked: row.get::<_, i64>(5)? != 0,
        methods_tried: serde_json::from_str(&methods).unwrap_or_default(),
        web_pending: row.get::<_, i64>(7)? != 0,
        requested_at: time_col(row, 8)?,
        last_request_at: time_col(row, 9)?,
        sweep_after: time_col(row, 10)?,
        sorted_count: row.get(11)?,
        last_sorted_at: row.get::<_, Option<String>>(12)?.as_deref().and_then(parse_stamp),
        last_seen_at: row.get::<_, Option<String>>(13)?.as_deref().and_then(parse_stamp),
    })
}

pub fn find(conn: &Connection, account_id: &str, key: &ListKey) -> rusqlite::Result<Option<Unsubscription>> {
    conn.query_row(
        &format!("SELECT {COLUMNS} FROM unsubscriptions WHERE account_id = ?1 AND key_kind = ?2 AND key_value = ?3"),
        params![account_id, key.kind.as_str(), key.value],
        from_row,
    )
    .optional()
}

pub fn get(conn: &Connection, id: &str) -> rusqlite::Result<Option<Unsubscription>> {
    conn.query_row(&format!("SELECT {COLUMNS} FROM unsubscriptions WHERE id = ?1"), params![id], from_row).optional()
}

pub fn for_account(conn: &Connection, account_id: &str) -> rusqlite::Result<Vec<Unsubscription>> {
    conn.prepare(&format!("SELECT {COLUMNS} FROM unsubscriptions WHERE account_id = ?1"))?
        .query_map(params![account_id], from_row)?
        .collect()
}

struct NewEntry<'a> {
    account_id: &'a str,
    key: &'a ListKey,
    display_name: &'a str,
    blocked: bool,
    methods: &'a [&'a str],
    web_pending: bool,
    now: DateTime<Utc>,
    sweep_after: DateTime<Utc>,
}

fn insert(conn: &Connection, e: NewEntry) -> rusqlite::Result<Unsubscription> {
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO unsubscriptions (id, account_id, key_kind, key_value, display_name, blocked, methods_tried, web_pending, requested_at, last_request_at, sweep_after)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9, ?10)",
        params![
            id,
            e.account_id,
            e.key.kind.as_str(),
            e.key.value,
            e.display_name,
            e.blocked as i64,
            serde_json::to_string(e.methods).unwrap_or_else(|_| "[]".into()),
            e.web_pending as i64,
            stamp(e.now),
            stamp(e.sweep_after)
        ],
    )?;
    get(conn, &id)?.ok_or(rusqlite::Error::QueryReturnedNoRows)
}

pub fn insert_request(
    conn: &Connection,
    account_id: &str,
    key: &ListKey,
    display_name: &str,
    method: &str,
    web_pending: bool,
    now: DateTime<Utc>,
) -> rusqlite::Result<Unsubscription> {
    insert(
        conn,
        NewEntry { account_id, key, display_name, blocked: false, methods: &[method], web_pending, now, sweep_after: now + Duration::days(GRACE_DAYS) },
    )
}

pub fn insert_block(conn: &Connection, account_id: &str, key: &ListKey, display_name: &str, now: DateTime<Utc>) -> rusqlite::Result<Unsubscription> {
    insert(conn, NewEntry { account_id, key, display_name, blocked: true, methods: &[], web_pending: false, now, sweep_after: now })
}

pub fn record_retry(conn: &Connection, id: &str, method: &str, web_pending: bool, now: DateTime<Utc>) -> rusqlite::Result<()> {
    let Some(sub) = get(conn, id)? else { return Err(rusqlite::Error::QueryReturnedNoRows) };
    let mut methods = sub.methods_tried;
    methods.push(method.to_string());
    conn.execute(
        "UPDATE unsubscriptions SET methods_tried = ?1, web_pending = ?2, last_request_at = ?3 WHERE id = ?4",
        params![serde_json::to_string(&methods).unwrap_or_else(|_| "[]".into()), web_pending as i64, stamp(now), id],
    )?;
    Ok(())
}

pub fn record_sorted(conn: &Connection, id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE unsubscriptions SET sorted_count = sorted_count + 1, last_sorted_at = ?1 WHERE id = ?2",
        params![stamp(now), id],
    )?;
    Ok(())
}

/// A spared match was not moved, but it still shows the list did not stop.
pub fn record_seen(conn: &Connection, id: &str, now: DateTime<Utc>) -> rusqlite::Result<()> {
    conn.execute("UPDATE unsubscriptions SET last_seen_at = ?1 WHERE id = ?2", params![stamp(now), id])?;
    Ok(())
}

pub fn delete(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM unsubscriptions WHERE id = ?1", params![id])?;
    Ok(())
}

pub fn status(sub: &Unsubscription, now: DateTime<Utc>) -> &'static str {
    if sub.blocked {
        "blocked"
    } else if now < sub.last_request_at + Duration::days(GRACE_DAYS) {
        "waiting"
    } else if sub.last_sorted_at.max(sub.last_seen_at).is_some_and(|t| t > sub.last_request_at) {
        "still_sending"
    } else {
        "quiet"
    }
}

pub fn view(sub: &Unsubscription, now: DateTime<Utc>, can_retry: bool) -> UnsubscriptionView {
    UnsubscriptionView {
        id: sub.id.clone(),
        display_name: sub.display_name.clone(),
        status: status(sub, now),
        requested_at: stamp(sub.requested_at),
        web_pending: sub.web_pending,
        quiet_days: (now - sub.last_request_at).num_days().max(0) as u32,
        sorted_count: sub.sorted_count,
        can_retry,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::{seed_account, temp_db};

    fn at(s: &str) -> DateTime<Utc> {
        DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc)
    }

    fn t0() -> DateTime<Utc> {
        at("2026-10-01T08:00:00Z")
    }

    fn list() -> ListKey {
        ListKey { kind: KeyKind::ListId, value: "wr.halde-shop.example".into() }
    }

    #[test]
    fn request_waits_through_the_grace_period() {
        let db = temp_db();
        let conn = db.lock_db();
        let account = seed_account(&conn, "me@studio-halde.example");
        let sub = insert_request(&conn, &account, &list(), "Halde Shop", "one_click", false, t0()).unwrap();
        assert_eq!(status(&sub, at("2026-10-04T07:59:59Z")), "waiting");
        assert_eq!(status(&sub, at("2026-10-04T08:00:01Z")), "quiet");
        assert_eq!(view(&sub, at("2026-10-11T08:00:00Z"), false).quiet_days, 10);
    }

    #[test]
    fn sorted_mail_after_request_means_still_sending() {
        let db = temp_db();
        let conn = db.lock_db();
        let account = seed_account(&conn, "me@studio-halde.example");
        let sub = insert_request(&conn, &account, &list(), "Halde Shop", "one_click", false, t0()).unwrap();
        record_sorted(&conn, &sub.id, at("2026-10-05T08:00:00Z")).unwrap();
        let sub = get(&conn, &sub.id).unwrap().unwrap();
        assert_eq!(status(&sub, at("2026-10-05T08:00:00Z")), "still_sending");
        assert_eq!(sub.sorted_count, 1);
    }

    #[test]
    fn retry_restarts_waiting_but_keeps_sweep() {
        let db = temp_db();
        let conn = db.lock_db();
        let account = seed_account(&conn, "me@studio-halde.example");
        let sub = insert_request(&conn, &account, &list(), "Halde Shop", "one_click", false, t0()).unwrap();
        record_sorted(&conn, &sub.id, at("2026-10-05T08:00:00Z")).unwrap();
        record_retry(&conn, &sub.id, "mailto", false, at("2026-10-06T08:00:00Z")).unwrap();
        let sub = get(&conn, &sub.id).unwrap().unwrap();
        assert_eq!(status(&sub, at("2026-10-07T08:00:00Z")), "waiting");
        assert_eq!(sub.sweep_after, at("2026-10-04T08:00:00Z"));
        assert_eq!(sub.requested_at, t0());
        assert_eq!(sub.methods_tried, ["one_click", "mailto"]);
    }

    #[test]
    fn block_is_immediate() {
        let db = temp_db();
        let conn = db.lock_db();
        let account = seed_account(&conn, "me@studio-halde.example");
        let key = ListKey { kind: KeyKind::Sender, value: "gewinn@spam-halde.example".into() };
        let sub = insert_block(&conn, &account, &key, "Gewinnspiel", t0()).unwrap();
        assert_eq!(status(&sub, t0()), "blocked");
        assert_eq!(sub.sweep_after, t0());
        assert_eq!(find(&conn, &account, &key).unwrap().unwrap().id, sub.id);
    }

    #[test]
    fn one_entry_per_list() {
        let db = temp_db();
        let conn = db.lock_db();
        let account = seed_account(&conn, "me@studio-halde.example");
        insert_request(&conn, &account, &list(), "Halde Shop", "one_click", false, t0()).unwrap();
        assert!(insert_request(&conn, &account, &list(), "Halde Shop", "mailto", false, t0()).is_err());
        assert_eq!(for_account(&conn, &account).unwrap().len(), 1);
    }

    #[test]
    fn entries_go_with_their_account() {
        let db = temp_db();
        let conn = db.lock_db();
        let account = seed_account(&conn, "me@studio-halde.example");
        insert_request(&conn, &account, &list(), "Halde Shop", "one_click", false, t0()).unwrap();
        conn.execute("DELETE FROM accounts WHERE id = ?1", [&account]).unwrap();
        assert!(for_account(&conn, &account).unwrap().is_empty());
    }

    #[test]
    fn delete_removes_the_entry() {
        let db = temp_db();
        let conn = db.lock_db();
        let account = seed_account(&conn, "me@studio-halde.example");
        let sub = insert_request(&conn, &account, &list(), "Halde Shop", "web", true, t0()).unwrap();
        assert!(sub.web_pending);
        delete(&conn, &sub.id).unwrap();
        assert!(get(&conn, &sub.id).unwrap().is_none());
    }
}
