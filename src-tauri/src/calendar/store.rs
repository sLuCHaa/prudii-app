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

const EVENT_COLS: &str = "e.id, e.calendar_id, e.uid, e.recurrence_id, e.title, e.description, e.location, e.all_day, \
    e.dtstart, e.dtend, e.tzid, e.rrule, e.exdates, e.rdates, e.status, e.transparency, e.sequence, e.organizer_email, \
    e.organizer_name, e.is_organizer, e.my_partstat, e.account_id, e.ical_raw";

const ROLES: &[&str] = &["req-participant", "opt-participant", "chair", "non-participant"];
const PARTSTATS: &[&str] = &["needs-action", "accepted", "tentative", "declined", "delegated"];

fn json_list(s: Option<String>) -> Vec<String> {
    s.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

fn row_to_event(r: &rusqlite::Row) -> rusqlite::Result<EventRow> {
    Ok(EventRow {
        id: r.get(0)?,
        calendar_id: r.get(1)?,
        uid: r.get(2)?,
        recurrence_id: r.get(3)?,
        title: r.get(4)?,
        description: r.get(5)?,
        location: r.get(6)?,
        all_day: r.get::<_, i64>(7)? != 0,
        dtstart: r.get(8)?,
        dtend: r.get(9)?,
        tzid: r.get(10)?,
        rrule: r.get(11)?,
        exdates: json_list(r.get(12)?),
        rdates: json_list(r.get(13)?),
        status: r.get(14)?,
        transparency: r.get(15)?,
        sequence: r.get(16)?,
        organizer_email: r.get(17)?,
        organizer_name: r.get(18)?,
        is_organizer: r.get::<_, i64>(19)? != 0,
        my_partstat: r.get(20)?,
        account_id: r.get(21)?,
        ical_raw: r.get(22)?,
    })
}

fn fetch_event(conn: &Connection, id: &str) -> Result<EventRow, String> {
    conn.query_row(&format!("SELECT {} FROM events e WHERE e.id = ?1", EVENT_COLS), params![id], row_to_event)
        .optional()
        .map_err(err)?
        .ok_or_else(|| "calendar.errors.notFound".to_string())
}

fn find_slot(conn: &Connection, calendar_id: &str, uid: &str, recurrence_id: Option<&str>) -> Result<Option<EventRow>, String> {
    conn.query_row(
        &format!(
            "SELECT {} FROM events e WHERE e.calendar_id = ?1 AND e.uid = ?2 AND IFNULL(e.recurrence_id, '') = IFNULL(?3, '')",
            EVENT_COLS
        ),
        params![calendar_id, uid, recurrence_id],
        row_to_event,
    )
    .optional()
    .map_err(err)
}

/// Inserts or overwrites a row by id, recomputing the derived range columns.
fn write_event(conn: &Connection, ev: &EventRow) -> Result<(), String> {
    let (start_utc, range_end) = derive_range(ev).ok_or_else(|| "calendar.errors.invalidTimes".to_string())?;
    let exdates = serde_json::to_string(&ev.exdates).map_err(err)?;
    let rdates = serde_json::to_string(&ev.rdates).map_err(err)?;
    conn.execute(
        "INSERT INTO events (id, calendar_id, uid, recurrence_id, title, description, location, all_day, dtstart, dtend, tzid,
            start_utc, range_end_utc, rrule, exdates, rdates, status, transparency, sequence, organizer_email, organizer_name,
            is_organizer, my_partstat, account_id, ical_raw)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18,?19,?20,?21,?22,?23,?24,?25)
         ON CONFLICT(id) DO UPDATE SET calendar_id = excluded.calendar_id, uid = excluded.uid,
            recurrence_id = excluded.recurrence_id, title = excluded.title, description = excluded.description,
            location = excluded.location, all_day = excluded.all_day, dtstart = excluded.dtstart, dtend = excluded.dtend,
            tzid = excluded.tzid, start_utc = excluded.start_utc, range_end_utc = excluded.range_end_utc,
            rrule = excluded.rrule, exdates = excluded.exdates, rdates = excluded.rdates, status = excluded.status,
            transparency = excluded.transparency, sequence = excluded.sequence, organizer_email = excluded.organizer_email,
            organizer_name = excluded.organizer_name, is_organizer = excluded.is_organizer,
            my_partstat = excluded.my_partstat, account_id = excluded.account_id, ical_raw = excluded.ical_raw,
            updated_at = datetime('now')",
        params![
            ev.id, ev.calendar_id, ev.uid, ev.recurrence_id, ev.title, ev.description, ev.location, ev.all_day as i64,
            ev.dtstart, ev.dtend, ev.tzid, start_utc, range_end, ev.rrule, exdates, rdates, ev.status, ev.transparency,
            ev.sequence, ev.organizer_email, ev.organizer_name, ev.is_organizer as i64, ev.my_partstat, ev.account_id,
            ev.ical_raw
        ],
    )
    .map_err(err)?;
    Ok(())
}

fn set_alarms(conn: &Connection, event_id: &str, alarms: &[i64]) -> Result<(), String> {
    conn.execute("DELETE FROM event_alarms WHERE event_id = ?1", params![event_id]).map_err(err)?;
    let mut list: Vec<i64> = alarms.iter().copied().filter(|m| (0..=MAX_ALARM_MINUTES).contains(m)).collect();
    list.sort_unstable();
    list.dedup();
    for m in list {
        conn.execute(
            "INSERT INTO event_alarms (id, event_id, minutes_before) VALUES (?1, ?2, ?3)",
            params![uuid::Uuid::new_v4().to_string(), event_id, m],
        )
        .map_err(err)?;
    }
    Ok(())
}

pub(crate) fn load_alarms(conn: &Connection, event_id: &str) -> Result<Vec<i64>, String> {
    let mut stmt = conn
        .prepare("SELECT minutes_before FROM event_alarms WHERE event_id = ?1 ORDER BY minutes_before")
        .map_err(err)?;
    let rows = stmt.query_map(params![event_id], |r| r.get(0)).map_err(err)?.collect::<Result<Vec<i64>, _>>().map_err(err);
    rows
}

fn load_attendees(conn: &Connection, event_id: &str) -> Result<Vec<Attendee>, String> {
    let mut stmt = conn
        .prepare("SELECT email, name, role, partstat, rsvp, comment FROM event_attendees WHERE event_id = ?1 ORDER BY rowid")
        .map_err(err)?;
    let rows = stmt
        .query_map(params![event_id], |r| {
            Ok(Attendee {
                email: r.get(0)?,
                name: r.get(1)?,
                role: r.get(2)?,
                partstat: r.get(3)?,
                rsvp: r.get::<_, i64>(4)? != 0,
                comment: r.get(5)?,
            })
        })
        .map_err(err)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(err);
    rows
}

fn set_attendees(conn: &Connection, event_id: &str, list: &[Attendee]) -> Result<(), String> {
    conn.execute("DELETE FROM event_attendees WHERE event_id = ?1", params![event_id]).map_err(err)?;
    for a in list {
        let role = if ROLES.contains(&a.role.as_str()) { a.role.as_str() } else { "req-participant" };
        let partstat = if PARTSTATS.contains(&a.partstat.as_str()) { a.partstat.as_str() } else { "needs-action" };
        conn.execute(
            "INSERT OR REPLACE INTO event_attendees (event_id, email, name, role, partstat, rsvp, comment) VALUES (?1,?2,?3,?4,?5,?6,?7)",
            params![event_id, a.email.trim().to_lowercase(), a.name, role, partstat, a.rsvp as i64, a.comment],
        )
        .map_err(err)?;
    }
    Ok(())
}

fn copy_children(conn: &Connection, from_id: &str, to_id: &str) -> Result<(), String> {
    let alarms = load_alarms(conn, from_id)?;
    set_alarms(conn, to_id, &alarms)?;
    let attendees = load_attendees(conn, from_id)?;
    set_attendees(conn, to_id, &attendees)
}

fn detail_of(conn: &Connection, id: &str) -> Result<EventDetail, String> {
    let event = fetch_event(conn, id)?;
    let calendar_color = fetch_calendar(conn, &event.calendar_id).map(|c| c.color).unwrap_or_else(|_| DEFAULT_COLOR.to_string());
    Ok(EventDetail { alarms: load_alarms(conn, id)?, attendees: load_attendees(conn, id)?, calendar_color, event })
}

fn clean_rule(rule: Option<String>) -> Option<String> {
    rule.map(|r| r.trim().trim_start_matches("RRULE:").to_string()).filter(|r| !r.is_empty())
}

/// UI times → the row's frame. Timed values are instants and land as wall clock
/// in `tzid`, so an event in a foreign zone keeps its zone when moved.
fn times_to_frame(times: &EventTimes, tzid: Option<&str>) -> Result<(String, String), String> {
    let invalid = || "calendar.errors.invalidTimes".to_string();
    if times.all_day {
        let start = parse_date(&times.start).ok_or_else(invalid)?;
        let mut end = parse_date(&times.end).ok_or_else(invalid)?;
        if end <= start {
            end = start + Duration::days(1);
        }
        return Ok((fmt_date(start), fmt_date(end)));
    }
    let start = parse_utc(&times.start).ok_or_else(invalid)?;
    let end = parse_utc(&times.end).ok_or_else(invalid)?.max(start);
    let tz = row_tz(tzid);
    Ok((fmt_wall(utc_to_wall(&tz, start)), fmt_wall(utc_to_wall(&tz, end))))
}

pub(crate) fn create_event_impl(db: &Database, input: EventInput) -> Result<EventDetail, String> {
    let conn = db.lock_db();
    ensure_calendar(&conn, &input.calendar_id)?;
    let tzid = if input.times.all_day { None } else { Some(system_tz_name()) };
    let (dtstart, dtend) = times_to_frame(&input.times, tzid.as_deref())?;
    let id = uuid::Uuid::new_v4().to_string();
    let ev = EventRow {
        id: id.clone(),
        calendar_id: input.calendar_id,
        uid: format!("{}@prudii", uuid::Uuid::new_v4()),
        recurrence_id: None,
        title: input.title.trim().to_string(),
        description: input.description,
        location: input.location.trim().to_string(),
        all_day: input.times.all_day,
        dtstart,
        dtend,
        tzid,
        rrule: clean_rule(input.rrule),
        exdates: vec![],
        rdates: vec![],
        status: "confirmed".into(),
        transparency: "opaque".into(),
        sequence: 0,
        organizer_email: None,
        organizer_name: None,
        is_organizer: false,
        my_partstat: None,
        account_id: None,
        ical_raw: None,
    };
    let tx = conn.unchecked_transaction().map_err(err)?;
    write_event(&tx, &ev)?;
    set_alarms(&tx, &id, &input.alarms)?;
    tx.commit().map_err(err)?;
    detail_of(&conn, &id)
}

pub(crate) fn get_event_impl(db: &Database, id: &str) -> Result<EventDetail, String> {
    let conn = db.lock_db();
    detail_of(&conn, id)
}

fn override_keys(conn: &Connection, calendar_id: &str, uid: &str) -> Result<HashSet<String>, String> {
    let mut stmt = conn
        .prepare("SELECT recurrence_id FROM events WHERE calendar_id = ?1 AND uid = ?2 AND recurrence_id IS NOT NULL")
        .map_err(err)?;
    let keys = stmt.query_map(params![calendar_id, uid], |r| r.get(0)).map_err(err)?.collect::<Result<HashSet<String>, _>>().map_err(err);
    keys
}

pub(crate) fn occurrence_instant(o: &Occurrence, sys: Tz) -> DateTime<Utc> {
    if o.all_day {
        parse_date(&o.start).and_then(|d| d.and_hms_opt(0, 0, 0)).map(|n| wall_to_utc(&sys, n)).unwrap_or_default()
    } else {
        parse_utc(&o.start).unwrap_or_default()
    }
}

/// Occurrences overlapping [from, to); without `calendar_ids` only visible calendars count.
pub(crate) fn occurrences_in(
    conn: &Connection,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    calendar_ids: Option<&[String]>,
) -> Result<Vec<Occurrence>, String> {
    let filter = if calendar_ids.is_some() { "e.calendar_id IN (SELECT value FROM json_each(?3))" } else { "c.visible = 1" };
    let sql = format!(
        "SELECT {}, c.color, (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id = e.id)
         FROM events e JOIN calendars c ON c.id = e.calendar_id
         WHERE {} AND e.start_utc < ?1 AND (e.range_end_utc IS NULL OR e.range_end_utc > ?2)",
        EVENT_COLS, filter
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let map = |r: &rusqlite::Row| Ok((row_to_event(r)?, r.get::<_, String>(23)?, r.get::<_, i64>(24)?));
    let (to_s, from_s) = (fmt_utc(to), fmt_utc(from));
    let rows: Vec<(EventRow, String, i64)> = match calendar_ids {
        Some(ids) => {
            let json = serde_json::to_string(ids).map_err(err)?;
            stmt.query_map(params![to_s, from_s, json], map)
        }
        None => stmt.query_map(params![to_s, from_s], map),
    }
    .map_err(err)?
    .collect::<Result<Vec<_>, _>>()
    .map_err(err)?;

    let sys = system_tz();
    let mut out = Vec::new();
    for (ev, color, attendees) in &rows {
        let skip = if is_series(ev) { override_keys(conn, &ev.calendar_id, &ev.uid)? } else { HashSet::new() };
        out.extend(expand(ev, from, to, sys, &ExpandInput { color, has_attendees: *attendees > 0, skip_keys: &skip }));
    }
    out.sort_by_key(|o| occurrence_instant(o, sys));
    Ok(out)
}

pub(crate) fn list_occurrences_impl(db: &Database, from: &str, to: &str, calendar_ids: Option<Vec<String>>) -> Result<Vec<Occurrence>, String> {
    let (Some(from), Some(to)) = (parse_utc(from), parse_utc(to)) else {
        return Err("calendar.errors.invalidRange".into());
    };
    if to <= from {
        return Ok(Vec::new());
    }
    let conn = db.lock_db();
    occurrences_in(&conn, from, to, calendar_ids.as_deref())
}

const SEARCH_LIMIT: usize = 200;

pub(crate) fn search_events_impl(db: &Database, query: &str, from: &str) -> Result<Vec<Occurrence>, String> {
    let q = query.trim().to_lowercase();
    if q.chars().count() < 2 {
        return Ok(Vec::new());
    }
    let from = parse_utc(from).ok_or("calendar.errors.invalidRange")?;
    let conn = db.lock_db();
    let all = occurrences_in(&conn, from, from + Duration::days(366), None)?;
    Ok(all
        .into_iter()
        .filter(|o| [&o.title, &o.location, &o.description].iter().any(|f| f.to_lowercase().contains(&q)))
        .take(SEARCH_LIMIT)
        .collect())
}

pub(crate) fn count_today_impl(db: &Database) -> Result<i64, String> {
    let sys = system_tz();
    let today = Utc::now().with_timezone(&sys).date_naive();
    let midnight = |d: chrono::NaiveDate| wall_to_utc(&sys, d.and_hms_opt(0, 0, 0).expect("midnight is valid"));
    let conn = db.lock_db();
    let occ = occurrences_in(&conn, midnight(today), midnight(today + Duration::days(1)), None)?;
    Ok(occ.iter().filter(|o| o.status != "cancelled" && o.my_partstat.as_deref() != Some("declined")).count() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    pub(super) fn temp_db() -> Database {
        Database::new(std::env::temp_dir().join(format!("prudii-test-{}", uuid::Uuid::new_v4()))).unwrap()
    }

    pub(super) fn cal(db: &Database) -> String {
        list_calendars_impl(db, "Mine").unwrap().remove(0).id
    }

    pub(super) fn zoned_row(db: &Database, calendar_id: &str, tz: &str, dtstart: &str, dtend: &str, rrule: Option<&str>) -> String {
        let id = uuid::Uuid::new_v4().to_string();
        let ev = EventRow {
            id: id.clone(),
            calendar_id: calendar_id.into(),
            uid: format!("{}@test", id),
            recurrence_id: None,
            title: "T".into(),
            description: String::new(),
            location: String::new(),
            all_day: false,
            dtstart: dtstart.into(),
            dtend: dtend.into(),
            tzid: Some(tz.into()),
            rrule: rrule.map(str::to_string),
            exdates: vec![],
            rdates: vec![],
            status: "confirmed".into(),
            transparency: "opaque".into(),
            sequence: 0,
            organizer_email: None,
            organizer_name: None,
            is_organizer: false,
            my_partstat: None,
            account_id: None,
            ical_raw: None,
        };
        write_event(&db.lock_db(), &ev).unwrap();
        id
    }

    pub(super) fn list(db: &Database, from: &str, to: &str) -> Vec<Occurrence> {
        list_occurrences_impl(db, from, to, None).unwrap()
    }

    pub(super) fn timed(start: &str, end: &str) -> EventTimes {
        EventTimes { all_day: false, start: start.into(), end: end.into() }
    }

    pub(super) fn input(calendar_id: &str, title: &str, times: EventTimes) -> EventInput {
        EventInput {
            calendar_id: calendar_id.into(),
            title: title.into(),
            description: String::new(),
            location: String::new(),
            times,
            rrule: None,
            alarms: vec![],
        }
    }

    #[test]
    fn created_events_list_with_their_instants() {
        let db = temp_db();
        let c = cal(&db);
        let d = create_event_impl(
            &db,
            EventInput { location: "Room 1".into(), alarms: vec![15, 15, -5], ..input(&c, " Dentist ", timed("2026-10-15T07:00:00Z", "2026-10-15T08:00:00Z")) },
        )
        .unwrap();
        assert_eq!(d.event.title, "Dentist");
        assert_eq!(d.alarms, vec![15]);
        assert!(d.event.uid.ends_with("@prudii"));
        let occ = list(&db, "2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z");
        assert_eq!(occ.len(), 1);
        assert_eq!((occ[0].start.as_str(), occ[0].end.as_str()), ("2026-10-15T07:00:00Z", "2026-10-15T08:00:00Z"));
        assert_eq!(occ[0].occurrence_key, d.event.dtstart);
        assert_eq!(occ[0].location, "Room 1");
        assert!(list(&db, "2026-10-16T00:00:00Z", "2026-10-17T00:00:00Z").is_empty());
    }

    #[test]
    fn all_day_events_list_as_dates() {
        let db = temp_db();
        let c = cal(&db);
        let times = EventTimes { all_day: true, start: "2026-10-15".into(), end: "2026-10-15".into() };
        let d = create_event_impl(&db, input(&c, "Holiday", times)).unwrap();
        assert_eq!((d.event.dtstart.as_str(), d.event.dtend.as_str()), ("2026-10-15", "2026-10-16"), "end is exclusive and at least a day");
        assert_eq!(d.event.tzid, None);
        let occ = list(&db, "2026-10-14T12:00:00Z", "2026-10-16T12:00:00Z");
        assert_eq!((occ[0].start.as_str(), occ[0].end.as_str()), ("2026-10-15", "2026-10-16"));
    }

    #[test]
    fn hidden_calendars_drop_out_unless_asked_for() {
        let db = temp_db();
        let hidden = create_calendar_impl(&db, "Hidden", "#00ff00").unwrap();
        create_event_impl(&db, input(&hidden.id, "Secret", timed("2026-10-15T07:00:00Z", "2026-10-15T08:00:00Z"))).unwrap();
        update_calendar_impl(&db, &hidden.id, CalendarPatch { visible: Some(false), ..Default::default() }).unwrap();
        assert!(list(&db, "2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z").is_empty());
        let explicit = list_occurrences_impl(&db, "2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z", Some(vec![hidden.id.clone()])).unwrap();
        assert_eq!(explicit.len(), 1);
        assert_eq!(explicit[0].color, "#00ff00");
    }

    #[test]
    fn series_expand_in_listings() {
        let db = temp_db();
        let c = cal(&db);
        zoned_row(&db, &c, "Europe/Berlin", "2026-10-05T09:00:00", "2026-10-05T09:30:00", Some("FREQ=WEEKLY;BYDAY=MO"));
        let occ = list(&db, "2026-10-18T00:00:00Z", "2026-11-01T00:00:00Z");
        assert_eq!(occ.iter().map(|o| o.start.as_str()).collect::<Vec<_>>(), vec!["2026-10-19T07:00:00Z", "2026-10-26T08:00:00Z"]);
        assert!(occ.iter().all(|o| o.is_recurring && !o.is_override));
    }

    #[test]
    fn search_matches_text_fields_from_a_start_date() {
        let db = temp_db();
        let c = cal(&db);
        create_event_impl(
            &db,
            EventInput { location: "Café Zentral".into(), ..input(&c, "Lunch", timed("2026-10-15T10:00:00Z", "2026-10-15T11:00:00Z")) },
        )
        .unwrap();
        assert_eq!(search_events_impl(&db, "zentral", "2026-10-01T00:00:00Z").unwrap().len(), 1);
        assert_eq!(search_events_impl(&db, "LUNCH", "2026-10-01T00:00:00Z").unwrap().len(), 1);
        assert!(search_events_impl(&db, "lunch", "2026-10-16T00:00:00Z").unwrap().is_empty());
        assert!(search_events_impl(&db, "x", "2026-10-01T00:00:00Z").unwrap().is_empty());
    }

    #[test]
    fn today_count_skips_cancelled_events() {
        let db = temp_db();
        let c = cal(&db);
        let now = Utc::now();
        let t = timed(&fmt_utc(now), &fmt_utc(now + Duration::minutes(30)));
        create_event_impl(&db, input(&c, "Now", t.clone())).unwrap();
        let off = create_event_impl(&db, input(&c, "Off", t)).unwrap();
        db.lock_db().execute("UPDATE events SET status = 'cancelled' WHERE id = ?1", params![off.event.id]).unwrap();
        assert_eq!(count_today_impl(&db).unwrap(), 1);
    }

    #[test]
    fn rejects_unknown_calendars_and_bad_ranges() {
        let db = temp_db();
        assert_eq!(
            create_event_impl(&db, input("nope", "x", timed("2026-10-15T07:00:00Z", "2026-10-15T08:00:00Z"))).unwrap_err(),
            "calendar.errors.notFound"
        );
        assert_eq!(list_occurrences_impl(&db, "yesterday", "2026-10-16T00:00:00Z", None).unwrap_err(), "calendar.errors.invalidRange");
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
