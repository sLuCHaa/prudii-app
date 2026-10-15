//! Calendar persistence. Every function takes `&Database` so it runs in tests
//! without Tauri; `commands/calendar.rs` only adds events and file dialogs.

use super::ical::{calendar_to_ics, parse_calendar, ExportEvent};
use super::recurrence::{
    derive_range, expand, is_series, key_to_naive, naive_to_key, rule_count, shift_key, shift_rrule_days, slot_shape,
    slots_before, truncate_before, with_count, ExpandInput,
};
use super::tz::{fmt_date, fmt_utc, fmt_wall, parse_date, parse_utc, row_tz, system_tz, system_tz_name, utc_to_wall, wall_to_utc};
use super::{
    Attendee, Calendar, CalendarPatch, CalendarSettings, EventDetail, EventInput, EventPatch, EventRow, EventTimes,
    ImportResult, Occurrence, Scope,
};
use crate::db::Database;
use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};

pub const DEFAULT_COLOR: &str = "#3b82f6";
const MAX_ALARM_MINUTES: i64 = 7 * 24 * 60;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

const CAL_SELECT: &str = "SELECT id, name, color, is_default, visible, sort_order, source FROM calendars";

fn row_to_calendar(r: &rusqlite::Row) -> rusqlite::Result<Calendar> {
    Ok(Calendar {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        is_default: r.get::<_, i64>(3)? != 0,
        visible: r.get::<_, i64>(4)? != 0,
        sort_order: r.get(5)?,
        source: r.get(6)?,
    })
}

fn fetch_calendars(conn: &Connection) -> Result<Vec<Calendar>, String> {
    let mut stmt = conn.prepare(&format!("{} ORDER BY sort_order, created_at", CAL_SELECT)).map_err(err)?;
    let rows = stmt.query_map([], row_to_calendar).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err);
    rows
}

fn fetch_calendar(conn: &Connection, id: &str) -> Result<Calendar, String> {
    conn.query_row(&format!("{} WHERE id = ?1", CAL_SELECT), params![id], row_to_calendar)
        .optional()
        .map_err(err)?
        .ok_or_else(|| "calendar.errors.notFound".to_string())
}

fn ensure_calendar(conn: &Connection, id: &str) -> Result<(), String> {
    fetch_calendar(conn, id).map(|_| ())
}

fn is_valid_color(c: &str) -> bool {
    c.len() == 7 && c.starts_with('#') && c[1..].chars().all(|ch| ch.is_ascii_hexdigit())
}

/// `default_name` is the UI's translation; Rust does not know the resolved
/// interface language.
pub(crate) fn list_calendars_impl(db: &Database, default_name: &str) -> Result<Vec<Calendar>, String> {
    let conn = db.lock_db();
    let existing = fetch_calendars(&conn)?;
    if !existing.is_empty() {
        return Ok(existing);
    }
    let name = if default_name.trim().is_empty() { "Calendar" } else { default_name.trim() };
    conn.execute(
        "INSERT INTO calendars (id, name, color, is_default, sort_order) VALUES (?1, ?2, ?3, 1, 0)",
        params![uuid::Uuid::new_v4().to_string(), name, DEFAULT_COLOR],
    )
    .map_err(err)?;
    fetch_calendars(&conn)
}

pub(crate) fn create_calendar_impl(db: &Database, name: &str, color: &str) -> Result<Calendar, String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("calendar.errors.emptyName".into());
    }
    let color = if is_valid_color(color) { color } else { DEFAULT_COLOR };
    let conn = db.lock_db();
    let (count, next): (i64, f64) = conn
        .query_row("SELECT COUNT(*), COALESCE(MAX(sort_order), -1) + 1 FROM calendars", [], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(err)?;
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO calendars (id, name, color, is_default, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, color, (count == 0) as i64, next],
    )
    .map_err(err)?;
    fetch_calendar(&conn, &id)
}

pub(crate) fn update_calendar_impl(db: &Database, id: &str, patch: CalendarPatch) -> Result<Calendar, String> {
    let conn = db.lock_db();
    ensure_calendar(&conn, id)?;
    let tx = conn.unchecked_transaction().map_err(err)?;
    if let Some(name) = patch.name.as_deref().map(str::trim) {
        if name.is_empty() {
            return Err("calendar.errors.emptyName".into());
        }
        tx.execute("UPDATE calendars SET name = ?1 WHERE id = ?2", params![name, id]).map_err(err)?;
    }
    if let Some(color) = patch.color.as_deref().filter(|c| is_valid_color(c)) {
        tx.execute("UPDATE calendars SET color = ?1 WHERE id = ?2", params![color, id]).map_err(err)?;
    }
    if let Some(visible) = patch.visible {
        tx.execute("UPDATE calendars SET visible = ?1 WHERE id = ?2", params![visible as i64, id]).map_err(err)?;
    }
    if let Some(order) = patch.sort_order {
        tx.execute("UPDATE calendars SET sort_order = ?1 WHERE id = ?2", params![order, id]).map_err(err)?;
    }
    if patch.is_default == Some(true) {
        tx.execute("UPDATE calendars SET is_default = CASE WHEN id = ?1 THEN 1 ELSE 0 END", params![id]).map_err(err)?;
    }
    tx.execute("UPDATE calendars SET updated_at = datetime('now') WHERE id = ?1", params![id]).map_err(err)?;
    tx.commit().map_err(err)?;
    fetch_calendar(&conn, id)
}

pub(crate) fn delete_calendar_impl(db: &Database, id: &str) -> Result<(), String> {
    let conn = db.lock_db();
    let cal = fetch_calendar(&conn, id)?;
    let count: i64 = conn.query_row("SELECT COUNT(*) FROM calendars", [], |r| r.get(0)).map_err(err)?;
    if count <= 1 {
        return Err("calendar.errors.lastCalendar".into());
    }
    let tx = conn.unchecked_transaction().map_err(err)?;
    tx.execute("DELETE FROM calendars WHERE id = ?1", params![id]).map_err(err)?;
    if cal.is_default {
        tx.execute(
            "UPDATE calendars SET is_default = 1 WHERE id = (SELECT id FROM calendars ORDER BY sort_order, created_at LIMIT 1)",
            [],
        )
        .map_err(err)?;
    }
    tx.commit().map_err(err)
}

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row("SELECT value FROM app_settings WHERE key = ?1", params![key], |r| r.get(0)).ok()
}

fn write_setting(conn: &Connection, key: &str, value: &str) -> Result<(), String> {
    conn.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?1, ?2)", params![key, value])
        .map(|_| ())
        .map_err(err)
}

pub(crate) fn get_calendar_settings_impl(db: &Database) -> CalendarSettings {
    let conn = db.lock_db();
    let num = |key: &str| read_setting(&conn, key).and_then(|v| v.trim().parse::<i64>().ok());
    let default_reminder_minutes = match read_setting(&conn, "calendar_default_reminder").as_deref() {
        Some("none") => None,
        _ => Some(num("calendar_default_reminder").filter(|m| (0..=MAX_ALARM_MINUTES).contains(m)).unwrap_or(15)),
    };
    let (mut start, mut end) = (num("calendar_work_start").unwrap_or(8), num("calendar_work_end").unwrap_or(18));
    if !(0..24).contains(&start) || !(1..=24).contains(&end) || end <= start {
        (start, end) = (8, 18);
    }
    let work_days: Vec<u32> = read_setting(&conn, "calendar_work_days")
        .map(|v| v.split(',').filter_map(|d| d.trim().parse::<u32>().ok()).filter(|d| *d < 7).collect::<Vec<_>>())
        .filter(|v| !v.is_empty())
        .unwrap_or_else(|| vec![1, 2, 3, 4, 5]);
    CalendarSettings {
        default_reminder_minutes,
        default_duration_minutes: num("calendar_default_duration").filter(|m| (5..=1440).contains(m)).unwrap_or(60),
        work_start_hour: start as u32,
        work_end_hour: end as u32,
        work_days,
    }
}

pub(crate) fn update_calendar_settings_impl(db: &Database, s: &CalendarSettings) -> Result<(), String> {
    let valid = (5..=1440).contains(&s.default_duration_minutes)
        && s.work_start_hour < 24
        && s.work_end_hour <= 24
        && s.work_end_hour > s.work_start_hour
        && !s.work_days.is_empty()
        && s.work_days.iter().all(|d| *d < 7)
        && s.default_reminder_minutes.map(|m| (0..=MAX_ALARM_MINUTES).contains(&m)).unwrap_or(true);
    if !valid {
        return Err("calendar.errors.invalidSettings".into());
    }
    let mut days = s.work_days.clone();
    days.sort_unstable();
    days.dedup();
    let conn = db.lock_db();
    let reminder = s.default_reminder_minutes.map(|m| m.to_string()).unwrap_or_else(|| "none".into());
    write_setting(&conn, "calendar_default_reminder", &reminder)?;
    write_setting(&conn, "calendar_default_duration", &s.default_duration_minutes.to_string())?;
    write_setting(&conn, "calendar_work_start", &s.work_start_hour.to_string())?;
    write_setting(&conn, "calendar_work_end", &s.work_end_hour.to_string())?;
    write_setting(&conn, "calendar_work_days", &days.iter().map(|d| d.to_string()).collect::<Vec<_>>().join(","))
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn temp_db() -> Database {
        Database::new(std::env::temp_dir().join(format!("prudii-test-{}", uuid::Uuid::new_v4()))).unwrap()
    }

    #[test]
    fn first_listing_seeds_one_default_calendar() {
        let db = temp_db();
        let first = list_calendars_impl(&db, "My calendar").unwrap();
        assert_eq!(first.len(), 1);
        assert!(first[0].is_default);
        assert_eq!(first[0].name, "My calendar");
        assert_eq!(list_calendars_impl(&db, "Other").unwrap(), first);
    }

    #[test]
    fn default_flag_stays_exclusive() {
        let db = temp_db();
        let a = list_calendars_impl(&db, "A").unwrap().remove(0);
        let b = create_calendar_impl(&db, "B", "#ff0000").unwrap();
        assert!(!b.is_default);
        update_calendar_impl(&db, &b.id, CalendarPatch { is_default: Some(true), ..Default::default() }).unwrap();
        let all = list_calendars_impl(&db, "").unwrap();
        let defaults: Vec<String> = all.iter().filter(|c| c.is_default).map(|c| c.id.clone()).collect();
        assert_eq!(defaults, vec![b.id.clone()]);
        assert!(!all.iter().find(|c| c.id == a.id).unwrap().is_default);
    }

    #[test]
    fn rejects_empty_names_and_keeps_the_last_calendar() {
        let db = temp_db();
        let only = list_calendars_impl(&db, "Only").unwrap().remove(0);
        assert_eq!(create_calendar_impl(&db, "  ", "#000000").unwrap_err(), "calendar.errors.emptyName");
        assert_eq!(delete_calendar_impl(&db, &only.id).unwrap_err(), "calendar.errors.lastCalendar");
    }

    #[test]
    fn deleting_the_default_promotes_another() {
        let db = temp_db();
        let a = list_calendars_impl(&db, "A").unwrap().remove(0);
        let b = create_calendar_impl(&db, "B", "not-a-color").unwrap();
        assert_eq!(b.color, DEFAULT_COLOR);
        delete_calendar_impl(&db, &a.id).unwrap();
        let left = list_calendars_impl(&db, "").unwrap();
        assert_eq!(left.len(), 1);
        assert!(left[0].is_default);
    }

    #[test]
    fn calendar_settings_round_trip_and_validate() {
        let db = temp_db();
        assert_eq!(
            get_calendar_settings_impl(&db),
            CalendarSettings {
                default_reminder_minutes: Some(15),
                default_duration_minutes: 60,
                work_start_hour: 8,
                work_end_hour: 18,
                work_days: vec![1, 2, 3, 4, 5],
            }
        );
        let custom = CalendarSettings {
            default_reminder_minutes: None,
            default_duration_minutes: 30,
            work_start_hour: 7,
            work_end_hour: 16,
            work_days: vec![5, 1, 1, 2],
        };
        update_calendar_settings_impl(&db, &custom).unwrap();
        assert_eq!(get_calendar_settings_impl(&db), CalendarSettings { work_days: vec![1, 2, 5], ..custom.clone() });
        let broken = CalendarSettings { work_start_hour: 18, work_end_hour: 8, ..custom };
        assert_eq!(update_calendar_settings_impl(&db, &broken).unwrap_err(), "calendar.errors.invalidSettings");
    }
}
