//! Calendar persistence. Every function takes `&Database` so it runs in tests
//! without Tauri; `commands/calendar.rs` only adds events and file dialogs.

use super::ical::{calendar_to_ics, parse_calendar, ExportEvent, ParsedCalendar};
use super::recurrence::{
    derive_range, expand, is_series, key_to_naive, naive_to_key, rebound_until, rule_count, shift_key, shift_rrule_days, shift_until,
    slot_shape, slots_before, truncate_before, with_count, ExpandInput,
};
use super::tz::{fmt_date, fmt_utc, fmt_wall, parse_date, parse_utc, row_tz, system_tz, system_tz_name, utc_to_wall, wall_to_utc};
use super::{
    Attendee, Calendar, CalendarPatch, CalendarSettings, EventDetail, EventInput, EventPatch, EventRow, EventTimes,
    FeedMeta, ImportResult, MirrorResult, Occurrence, Scope, REFRESH_CHOICES, SUBSCRIPTION,
};
use crate::db::Database;
use chrono::{DateTime, Duration, NaiveDate, Utc};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::{HashMap, HashSet};

pub const DEFAULT_COLOR: &str = "#3b82f6";
const MAX_ALARM_MINUTES: i64 = 7 * 24 * 60;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

const CAL_SELECT: &str = "SELECT id, name, color, is_default, visible, sort_order, source, refresh_minutes, last_synced_at, \
    last_error, reminders_muted FROM calendars";

fn row_to_calendar(r: &rusqlite::Row) -> rusqlite::Result<Calendar> {
    let source: String = r.get(6)?;
    Ok(Calendar {
        id: r.get(0)?,
        name: r.get(1)?,
        color: r.get(2)?,
        is_default: r.get::<_, i64>(3)? != 0,
        visible: r.get::<_, i64>(4)? != 0,
        sort_order: r.get(5)?,
        read_only: source == SUBSCRIPTION,
        source,
        refresh_minutes: r.get(7)?,
        last_synced_at: r.get(8)?,
        last_error: r.get(9)?,
        reminders_muted: r.get::<_, i64>(10)? != 0,
    })
}

fn fetch_calendars(conn: &Connection) -> Result<Vec<Calendar>, String> {
    let mut stmt = conn.prepare(&format!("{} ORDER BY sort_order, created_at", CAL_SELECT)).map_err(err)?;
    let rows = stmt.query_map([], row_to_calendar).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err);
    rows
}

pub(crate) fn fetch_calendar(conn: &Connection, id: &str) -> Result<Calendar, String> {
    conn.query_row(&format!("{} WHERE id = ?1", CAL_SELECT), params![id], row_to_calendar)
        .optional()
        .map_err(err)?
        .ok_or_else(|| "calendar.errors.notFound".to_string())
}

fn ensure_calendar(conn: &Connection, id: &str) -> Result<(), String> {
    fetch_calendar(conn, id).map(|_| ())
}

/// Subscribed calendars mirror their feed; only the feed may change them.
pub(crate) fn ensure_writable(conn: &Connection, calendar_id: &str) -> Result<(), String> {
    if fetch_calendar(conn, calendar_id)?.read_only {
        return Err("calendar.errors.readOnly".into());
    }
    Ok(())
}

pub(crate) fn is_valid_color(c: &str) -> bool {
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
    let (has_default, next): (bool, f64) = conn
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM calendars WHERE is_default = 1), COALESCE(MAX(sort_order), -1) + 1 FROM calendars",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(err)?;
    let id = uuid::Uuid::new_v4().to_string();
    conn.execute(
        "INSERT INTO calendars (id, name, color, is_default, sort_order) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![id, name, color, (!has_default) as i64, next],
    )
    .map_err(err)?;
    fetch_calendar(&conn, &id)
}

pub(crate) fn update_calendar_impl(db: &Database, id: &str, patch: CalendarPatch) -> Result<Calendar, String> {
    let conn = db.lock_db();
    let cal = fetch_calendar(&conn, id)?;
    if patch.is_default == Some(true) && cal.read_only {
        return Err("calendar.errors.readOnly".into());
    }
    if patch.refresh_minutes.is_some_and(|m| !cal.read_only || !REFRESH_CHOICES.contains(&m)) {
        return Err("calendar.errors.invalidSettings".into());
    }
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
    if let Some(muted) = patch.reminders_muted {
        tx.execute("UPDATE calendars SET reminders_muted = ?1 WHERE id = ?2", params![muted as i64, id]).map_err(err)?;
    }
    if let Some(minutes) = patch.refresh_minutes {
        tx.execute("UPDATE calendars SET refresh_minutes = ?1 WHERE id = ?2", params![minutes, id]).map_err(err)?;
    }
    tx.execute("UPDATE calendars SET updated_at = datetime('now') WHERE id = ?1", params![id]).map_err(err)?;
    tx.commit().map_err(err)?;
    fetch_calendar(&conn, id)
}

/// Returns the deleted calendar so the caller can drop a subscription's stored link.
pub(crate) fn delete_calendar_impl(db: &Database, id: &str) -> Result<Calendar, String> {
    let conn = db.lock_db();
    let cal = fetch_calendar(&conn, id)?;
    if !cal.read_only {
        let locals: i64 = conn
            .query_row("SELECT COUNT(*) FROM calendars WHERE source != ?1", params![SUBSCRIPTION], |r| r.get(0))
            .map_err(err)?;
        if locals <= 1 {
            return Err("calendar.errors.lastCalendar".into());
        }
    }
    let tx = conn.unchecked_transaction().map_err(err)?;
    tx.execute("DELETE FROM calendars WHERE id = ?1", params![id]).map_err(err)?;
    if cal.is_default {
        tx.execute(
            "UPDATE calendars SET is_default = 1 WHERE id = (
                SELECT id FROM calendars WHERE source != ?1 ORDER BY sort_order, created_at LIMIT 1
             )",
            params![SUBSCRIPTION],
        )
        .map_err(err)?;
    }
    tx.commit().map_err(err)?;
    Ok(cal)
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

pub(super) const EVENT_COLS: &str = "e.id, e.calendar_id, e.uid, e.recurrence_id, e.title, e.description, e.location, e.all_day, \
    e.dtstart, e.dtend, e.tzid, e.rrule, e.exdates, e.rdates, e.status, e.transparency, e.sequence, e.organizer_email, \
    e.organizer_name, e.is_organizer, e.my_partstat, e.account_id, e.ical_raw";

const ROLES: &[&str] = &["req-participant", "opt-participant", "chair", "non-participant"];
const PARTSTATS: &[&str] = &["needs-action", "accepted", "tentative", "declined", "delegated"];

fn json_list(s: Option<String>) -> Vec<String> {
    s.and_then(|v| serde_json::from_str(&v).ok()).unwrap_or_default()
}

pub(super) fn row_to_event(r: &rusqlite::Row) -> rusqlite::Result<EventRow> {
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

fn find_event(conn: &Connection, id: &str) -> Result<Option<EventRow>, String> {
    conn.query_row(&format!("SELECT {} FROM events e WHERE e.id = ?1", EVENT_COLS), params![id], row_to_event)
        .optional()
        .map_err(err)
}

fn fetch_event(conn: &Connection, id: &str) -> Result<EventRow, String> {
    find_event(conn, id)?.ok_or_else(|| "calendar.errors.notFound".to_string())
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
pub(super) fn write_event(conn: &Connection, ev: &EventRow) -> Result<(), String> {
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

pub(super) fn set_alarms(conn: &Connection, event_id: &str, alarms: &[i64]) -> Result<(), String> {
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

pub(super) fn set_attendees(conn: &Connection, event_id: &str, list: &[Attendee]) -> Result<(), String> {
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
    let (calendar_color, read_only) = fetch_calendar(conn, &event.calendar_id)
        .map(|c| (c.color, c.read_only))
        .unwrap_or_else(|_| (DEFAULT_COLOR.to_string(), false));
    Ok(EventDetail { alarms: load_alarms(conn, id)?, attendees: load_attendees(conn, id)?, calendar_color, read_only, event })
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
    ensure_writable(&conn, &input.calendar_id)?;
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
        "SELECT {}, c.color, (SELECT COUNT(*) FROM event_attendees a WHERE a.event_id = e.id), c.source = '{}'
         FROM events e JOIN calendars c ON c.id = e.calendar_id
         WHERE {} AND e.start_utc < ?1 AND (e.range_end_utc IS NULL OR e.range_end_utc > ?2)",
        EVENT_COLS, SUBSCRIPTION, filter
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let map = |r: &rusqlite::Row| Ok((row_to_event(r)?, r.get::<_, String>(23)?, r.get::<_, i64>(24)?, r.get::<_, i64>(25)? != 0));
    let (to_s, from_s) = (fmt_utc(to), fmt_utc(from));
    let rows: Vec<(EventRow, String, i64, bool)> = match calendar_ids {
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
    for (ev, color, attendees, read_only) in &rows {
        let skip = if is_series(ev) { override_keys(conn, &ev.calendar_id, &ev.uid)? } else { HashSet::new() };
        let input = ExpandInput { color, has_attendees: *attendees > 0, read_only: *read_only, skip_keys: &skip };
        out.extend(expand(ev, from, to, sys, &input));
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

fn apply_text(ev: &mut EventRow, p: &EventPatch) {
    if let Some(t) = &p.title {
        ev.title = t.trim().to_string();
    }
    if let Some(d) = &p.description {
        ev.description = d.clone();
    }
    if let Some(l) = &p.location {
        ev.location = l.trim().to_string();
    }
}

fn set_times(ev: &mut EventRow, times: &EventTimes) -> Result<(), String> {
    if times.all_day != ev.all_day {
        ev.all_day = times.all_day;
        ev.tzid = if times.all_day { None } else { Some(system_tz_name()) };
    }
    let (start, end) = times_to_frame(times, ev.tzid.as_deref())?;
    ev.dtstart = start;
    ev.dtend = end;
    Ok(())
}

/// The series row, the slot key being edited and that slot's override row;
/// None when the target is a standalone event.
fn resolve_series(conn: &Connection, target: &EventRow, key: Option<String>) -> Result<Option<(EventRow, String, Option<EventRow>)>, String> {
    if let Some(rid) = &target.recurrence_id {
        let master = find_slot(conn, &target.calendar_id, &target.uid, None)?;
        return Ok(master.map(|m| (m, rid.clone(), Some(target.clone()))));
    }
    if !is_series(target) {
        return Ok(None);
    }
    let key = key.unwrap_or_else(|| target.dtstart.clone());
    let existing = find_slot(conn, &target.calendar_id, &target.uid, Some(&key))?;
    Ok(Some((target.clone(), key, existing)))
}

fn delete_overrides(conn: &Connection, calendar_id: &str, uid: &str, from_key: Option<&str>) -> Result<(), String> {
    match from_key {
        Some(k) => conn.execute(
            "DELETE FROM events WHERE calendar_id = ?1 AND uid = ?2 AND recurrence_id IS NOT NULL AND recurrence_id >= ?3",
            params![calendar_id, uid, k],
        ),
        None => conn.execute(
            "DELETE FROM events WHERE calendar_id = ?1 AND uid = ?2 AND recurrence_id IS NOT NULL",
            params![calendar_id, uid],
        ),
    }
    .map(|_| ())
    .map_err(err)
}

fn override_ids(conn: &Connection, master: &EventRow) -> Result<Vec<String>, String> {
    let mut stmt = conn
        .prepare("SELECT id FROM events WHERE calendar_id = ?1 AND uid = ?2 AND recurrence_id IS NOT NULL ORDER BY recurrence_id")
        .map_err(err)?;
    let ids = stmt.query_map(params![master.calendar_id, master.uid], |r| r.get(0)).map_err(err)?.collect::<Result<Vec<String>, _>>().map_err(err);
    ids
}

fn shift_overrides(conn: &Connection, master: &EventRow, delta: Duration) -> Result<(), String> {
    let mut ids = override_ids(conn, master)?;
    // Walk against the shift so no row lands on a key another row still holds.
    if delta > Duration::zero() {
        ids.reverse();
    }
    for id in ids {
        let mut ov = fetch_event(conn, &id)?;
        ov.recurrence_id = ov.recurrence_id.map(|rid| shift_key(master.all_day, &rid, delta));
        ov.dtstart = shift_key(ov.all_day, &ov.dtstart, delta);
        ov.dtend = shift_key(ov.all_day, &ov.dtend, delta);
        write_event(conn, &ov)?;
    }
    Ok(())
}

/// Timed <-> all-day for a whole series: the first slot keeps its day (moved by
/// the edited slot's day shift) and exceptions keep naming the same days.
fn switch_series_form(conn: &Connection, master: &mut EventRow, key: Option<&str>, times: &EventTimes) -> Result<(), String> {
    let invalid = || "calendar.errors.invalidTimes".to_string();
    let old = master.clone();
    let day_of = |k: &str| key_to_naive(old.all_day, k).map(|n| n.date());
    set_times(master, times)?;
    let (start, len) = slot_shape(master).ok_or_else(invalid)?;
    let days = (start.date() - day_of(key.unwrap_or(&old.dtstart)).ok_or_else(invalid)?).num_days();
    let all_day = master.all_day;
    let at = |day: NaiveDate| (day + Duration::days(days)).and_time(start.time());
    let convert = |keys: &[String]| -> Vec<String> {
        let mut out: Vec<String> = keys.iter().filter_map(|k| day_of(k)).map(|d| naive_to_key(all_day, at(d))).collect();
        out.sort();
        out.dedup();
        out
    };
    let first = at(day_of(&old.dtstart).ok_or_else(invalid)?);
    master.dtstart = naive_to_key(all_day, first);
    master.dtend = naive_to_key(all_day, first + len);
    master.exdates = convert(&old.exdates);
    master.rdates = convert(&old.rdates);
    master.rrule = old.rrule.as_deref().map(|r| rebound_until(&shift_rrule_days(r, days), &old, master, days));
    let mut taken = HashSet::new();
    for id in override_ids(conn, &old)? {
        let mut ov = fetch_event(conn, &id)?;
        let rid = ov.recurrence_id.as_deref().and_then(day_of).map(|d| naive_to_key(all_day, at(d)));
        let own = key_to_naive(ov.all_day, &ov.dtstart).map(|n| at(n.date()));
        match (rid, own) {
            (Some(rid), Some(own)) if taken.insert(rid.clone()) => {
                ov.recurrence_id = Some(rid);
                ov.all_day = all_day;
                ov.tzid = master.tzid.clone();
                ov.dtstart = naive_to_key(all_day, own);
                ov.dtend = naive_to_key(all_day, own + len);
                write_event(conn, &ov)?;
            }
            _ => {
                conn.execute("DELETE FROM events WHERE id = ?1", params![id]).map_err(err)?;
            }
        }
    }
    Ok(())
}

/// Received invitations keep the organizer's SEQUENCE so later updates still compare against it.
fn bump_sequence(ev: &mut EventRow) {
    if ev.is_organizer || ev.organizer_email.is_none() {
        ev.sequence += 1;
    }
}

/// Standalone events and override rows: fields apply directly. Overrides never
/// take a rule or a calendar of their own.
fn update_single(conn: &Connection, mut ev: EventRow, patch: &EventPatch) -> Result<String, String> {
    apply_text(&mut ev, patch);
    if let Some(t) = &patch.times {
        set_times(&mut ev, t)?;
    }
    if ev.recurrence_id.is_none() {
        if patch.clear_rrule {
            ev.rrule = None;
        } else if patch.rrule.is_some() {
            ev.rrule = clean_rule(patch.rrule.clone());
        }
        if let Some(cal) = &patch.calendar_id {
            ensure_calendar(conn, cal)?;
            ev.calendar_id = cal.clone();
        }
    }
    bump_sequence(&mut ev);
    write_event(conn, &ev)?;
    if let Some(a) = &patch.alarms {
        set_alarms(conn, &ev.id, a)?;
    }
    Ok(ev.id)
}

fn update_this(conn: &Connection, master: &EventRow, key: &str, existing: Option<EventRow>, patch: &EventPatch) -> Result<String, String> {
    let ov = match existing {
        Some(o) => o,
        None => {
            let (_, len) = slot_shape(master).ok_or("calendar.errors.invalidTimes")?;
            let start = key_to_naive(master.all_day, key).ok_or("calendar.errors.invalidTimes")?;
            let mut o = master.clone();
            o.id = uuid::Uuid::new_v4().to_string();
            o.recurrence_id = Some(key.to_string());
            o.rrule = None;
            o.exdates.clear();
            o.rdates.clear();
            o.dtstart = naive_to_key(master.all_day, start);
            o.dtend = naive_to_key(master.all_day, start + len);
            write_event(conn, &o)?;
            copy_children(conn, &master.id, &o.id)?;
            o
        }
    };
    update_single(conn, ov, patch)
}

fn update_all(conn: &Connection, mut master: EventRow, key: Option<&str>, patch: &EventPatch) -> Result<String, String> {
    apply_text(&mut master, patch);
    if let Some(times) = &patch.times {
        if times.all_day != master.all_day {
            switch_series_form(conn, &mut master, key, times)?;
        } else {
            let invalid = || "calendar.errors.invalidTimes".to_string();
            let (new_start, new_end) = times_to_frame(times, master.tzid.as_deref())?;
            let anchor = key_to_naive(master.all_day, key.unwrap_or(master.dtstart.as_str())).ok_or_else(invalid)?;
            let ns = key_to_naive(master.all_day, &new_start).ok_or_else(invalid)?;
            let ne = key_to_naive(master.all_day, &new_end).ok_or_else(invalid)?;
            let delta = ns - anchor;
            let first = key_to_naive(master.all_day, &master.dtstart).ok_or_else(invalid)? + delta;
            master.dtstart = naive_to_key(master.all_day, first);
            master.dtend = naive_to_key(master.all_day, first + (ne - ns));
            if !delta.is_zero() {
                let day_shift = (ns.date() - anchor.date()).num_days();
                if let Some(rule) = &master.rrule {
                    master.rrule = Some(shift_until(&shift_rrule_days(rule, day_shift), master.all_day, delta));
                }
                let all_day = master.all_day;
                master.exdates = master.exdates.iter().map(|x| shift_key(all_day, x, delta)).collect();
                master.rdates = master.rdates.iter().map(|x| shift_key(all_day, x, delta)).collect();
                shift_overrides(conn, &master, delta)?;
            }
        }
    }
    if patch.clear_rrule {
        master.rrule = None;
        master.exdates.clear();
        master.rdates.clear();
        delete_overrides(conn, &master.calendar_id, &master.uid, None)?;
    } else if patch.rrule.is_some() {
        master.rrule = clean_rule(patch.rrule.clone());
    }
    if let Some(cal) = patch.calendar_id.as_ref().filter(|c| **c != master.calendar_id) {
        ensure_calendar(conn, cal)?;
        conn.execute(
            "UPDATE events SET calendar_id = ?1 WHERE calendar_id = ?2 AND uid = ?3 AND recurrence_id IS NOT NULL",
            params![cal, master.calendar_id, master.uid],
        )
        .map_err(err)?;
        master.calendar_id = cal.clone();
    }
    bump_sequence(&mut master);
    write_event(conn, &master)?;
    if let Some(a) = &patch.alarms {
        set_alarms(conn, &master.id, a)?;
    }
    Ok(master.id)
}

/// Ends `master` before slot `key` and returns a new series (fresh uid) for the
/// rest, taking its exceptions and overrides along.
fn split_series(conn: &Connection, master: &mut EventRow, key: &str) -> Result<EventRow, String> {
    let (_, len) = slot_shape(master).ok_or("calendar.errors.invalidTimes")?;
    let start = key_to_naive(master.all_day, key).ok_or("calendar.errors.invalidTimes")?;
    let mut tail = master.clone();
    tail.id = uuid::Uuid::new_v4().to_string();
    tail.uid = format!("{}@prudii", uuid::Uuid::new_v4());
    tail.dtstart = naive_to_key(master.all_day, start);
    tail.dtend = naive_to_key(master.all_day, start + len);
    tail.exdates = master.exdates.iter().filter(|x| x.as_str() >= key).cloned().collect();
    tail.rdates = master.rdates.iter().filter(|x| x.as_str() >= key).cloned().collect();
    tail.sequence = 0;
    tail.ical_raw = None;
    if let Some(rule) = master.rrule.clone() {
        if let Some(total) = rule_count(&rule) {
            let before = slots_before(master, key);
            tail.rrule = Some(with_count(&rule, total.saturating_sub(before).max(1)));
        }
        master.rrule = truncate_before(master, key);
    }
    master.exdates.retain(|x| x.as_str() < key);
    master.rdates.retain(|x| x.as_str() < key);
    bump_sequence(master);
    write_event(conn, master)?;
    write_event(conn, &tail)?;
    copy_children(conn, &master.id, &tail.id)?;
    conn.execute(
        "UPDATE events SET uid = ?1 WHERE calendar_id = ?2 AND uid = ?3 AND recurrence_id IS NOT NULL AND recurrence_id >= ?4",
        params![tail.uid, master.calendar_id, master.uid, key],
    )
    .map_err(err)?;
    Ok(tail)
}

/// After a series edit, the edited slot's override takes the patch's text and
/// times as they are instead of the series shift.
fn reapply_to_override(conn: &Connection, existing: Option<EventRow>, patch: &EventPatch) -> Result<(), String> {
    let Some(ov) = existing.map(|o| find_event(conn, &o.id)).transpose()?.flatten() else { return Ok(()) };
    let own = EventPatch {
        title: patch.title.clone(),
        description: patch.description.clone(),
        location: patch.location.clone(),
        times: patch.times.clone(),
        ..Default::default()
    };
    update_single(conn, ov, &own).map(|_| ())
}

pub(crate) fn update_event_impl(db: &Database, id: &str, occurrence_key: Option<String>, scope: Scope, patch: EventPatch) -> Result<EventDetail, String> {
    let conn = db.lock_db();
    let tx = conn.unchecked_transaction().map_err(err)?;
    let target = fetch_event(&tx, id)?;
    ensure_writable(&tx, &target.calendar_id)?;
    if let Some(cal) = &patch.calendar_id {
        ensure_writable(&tx, cal)?;
    }
    let result_id = match resolve_series(&tx, &target, occurrence_key)? {
        None => update_single(&tx, target, &patch)?,
        Some((mut master, key, existing)) => match scope {
            Scope::This => update_this(&tx, &master, &key, existing, &patch)?,
            Scope::Following if key != master.dtstart => {
                let tail = split_series(&tx, &mut master, &key)?;
                let id = update_all(&tx, tail, Some(&key), &patch)?;
                reapply_to_override(&tx, existing, &patch)?;
                id
            }
            Scope::Following | Scope::All => {
                let id = update_all(&tx, master, Some(&key), &patch)?;
                reapply_to_override(&tx, existing, &patch)?;
                id
            }
        },
    };
    tx.commit().map_err(err)?;
    detail_of(&conn, &result_id)
}

pub(crate) fn move_occurrence_impl(db: &Database, id: &str, occurrence_key: Option<String>, times: EventTimes, scope: Scope) -> Result<EventDetail, String> {
    update_event_impl(db, id, occurrence_key, scope, EventPatch { times: Some(times), ..Default::default() })
}

pub(crate) fn delete_event_impl(db: &Database, id: &str, occurrence_key: Option<String>, scope: Scope) -> Result<(), String> {
    let conn = db.lock_db();
    let tx = conn.unchecked_transaction().map_err(err)?;
    let target = fetch_event(&tx, id)?;
    ensure_writable(&tx, &target.calendar_id)?;
    match resolve_series(&tx, &target, occurrence_key)? {
        None => {
            tx.execute("DELETE FROM events WHERE id = ?1", params![target.id]).map_err(err)?;
        }
        Some((mut master, key, existing)) => match scope {
            Scope::This => {
                if let Some(o) = existing {
                    tx.execute("DELETE FROM events WHERE id = ?1", params![o.id]).map_err(err)?;
                }
                if !master.exdates.contains(&key) {
                    master.exdates.push(key);
                    master.exdates.sort();
                }
                bump_sequence(&mut master);
                write_event(&tx, &master)?;
            }
            Scope::Following if key != master.dtstart => {
                if master.rrule.is_some() {
                    master.rrule = truncate_before(&master, &key);
                }
                master.exdates.retain(|x| *x < key);
                master.rdates.retain(|x| *x < key);
                delete_overrides(&tx, &master.calendar_id, &master.uid, Some(&key))?;
                bump_sequence(&mut master);
                write_event(&tx, &master)?;
            }
            Scope::Following | Scope::All => {
                tx.execute("DELETE FROM events WHERE calendar_id = ?1 AND uid = ?2", params![master.calendar_id, master.uid])
                    .map_err(err)?;
            }
        },
    }
    tx.commit().map_err(err)
}

pub(crate) fn import_ics_impl(db: &Database, calendar_id: &str, text: &str) -> Result<ImportResult, String> {
    let parsed = parse_calendar(text);
    if parsed.events.is_empty() {
        return Err("calendar.errors.noEvents".into());
    }
    let conn = db.lock_db();
    ensure_writable(&conn, calendar_id)?;
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut result = ImportResult::default();
    for p in &parsed.events {
        let existing = find_slot(&tx, calendar_id, &p.uid, p.recurrence_id.as_deref())?;
        if existing.as_ref().is_some_and(|e| p.sequence < e.sequence) {
            result.skipped += 1;
            continue;
        }
        let id = existing.as_ref().map(|e| e.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let mut row = p.to_row(id, calendar_id.to_string());
        if let Some(e) = &existing {
            row.is_organizer = e.is_organizer;
            row.my_partstat = e.my_partstat.clone();
            row.account_id = e.account_id.clone();
        }
        if derive_range(&row).is_none() {
            result.skipped += 1;
            continue;
        }
        write_event(&tx, &row)?;
        set_alarms(&tx, &row.id, &p.alarms)?;
        set_attendees(&tx, &row.id, &p.attendees.iter().map(Attendee::from).collect::<Vec<_>>())?;
        if existing.is_some() {
            result.updated += 1;
        } else {
            result.imported += 1;
        }
    }
    tx.commit().map_err(err)?;
    Ok(result)
}

/// Makes a subscription's events equal the feed's. Rows keep their ids by
/// (uid, recurrence_id) so the reminder log and open views stay valid.
pub(crate) fn mirror_ics_impl(db: &Database, calendar_id: &str, parsed: &ParsedCalendar, meta: &FeedMeta) -> Result<MirrorResult, String> {
    if !parsed.has_calendar {
        return Err("calendar.errors.notCalendar".into());
    }
    let conn = db.lock_db();
    if !fetch_calendar(&conn, calendar_id)?.read_only {
        return Err("calendar.errors.notFound".into());
    }
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut result = MirrorResult::default();
    let mut keep: HashSet<String> = HashSet::new();
    for p in &parsed.events {
        let existing = find_slot(&tx, calendar_id, &p.uid, p.recurrence_id.as_deref())?;
        let id = existing.as_ref().map(|e| e.id.clone()).unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let row = p.to_row(id.clone(), calendar_id.to_string());
        if derive_range(&row).is_none() {
            result.skipped += 1;
            continue;
        }
        write_event(&tx, &row)?;
        set_alarms(&tx, &id, &p.alarms)?;
        set_attendees(&tx, &id, &p.attendees.iter().map(Attendee::from).collect::<Vec<_>>())?;
        keep.insert(id);
        if existing.is_some() {
            result.updated += 1;
        } else {
            result.imported += 1;
        }
    }
    let stale: Vec<String> = {
        let mut stmt = tx.prepare("SELECT id FROM events WHERE calendar_id = ?1").map_err(err)?;
        let ids = stmt.query_map(params![calendar_id], |r| r.get::<_, String>(0)).map_err(err)?.collect::<Result<Vec<_>, _>>().map_err(err)?;
        ids.into_iter().filter(|id| !keep.contains(id)).collect()
    };
    for id in &stale {
        tx.execute("DELETE FROM events WHERE id = ?1", params![id]).map_err(err)?;
    }
    result.removed = stale.len() as u32;
    let now = fmt_utc(Utc::now());
    tx.execute(
        "UPDATE calendars SET content_hash = ?1, sync_token = ?2, last_synced_at = ?3, last_attempt_at = ?3, last_error = NULL WHERE id = ?4",
        params![meta.hash, meta.etag, now, calendar_id],
    )
    .map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(result)
}

pub(crate) fn export_ics_impl(db: &Database, calendar_id: &str) -> Result<(String, String), String> {
    let conn = db.lock_db();
    let cal = fetch_calendar(&conn, calendar_id)?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {} FROM events e WHERE e.calendar_id = ?1 ORDER BY e.recurrence_id IS NOT NULL, e.start_utc",
            EVENT_COLS
        ))
        .map_err(err)?;
    let rows: Vec<EventRow> = stmt.query_map(params![calendar_id], row_to_event).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    let mut parts = Vec::with_capacity(rows.len());
    for row in rows {
        let alarms = load_alarms(&conn, &row.id)?;
        let attendees = load_attendees(&conn, &row.id)?;
        parts.push((row, alarms, attendees));
    }
    let events: Vec<ExportEvent> = parts.iter().map(|(row, alarms, attendees)| ExportEvent { row, alarms, attendees }).collect();
    Ok((cal.name.clone(), calendar_to_ics(&events, Some(&cal.name), None, Utc::now())))
}

/// (event id, occurrence start as listed, minutes before)
pub type SentKey = (String, String, i64);

/// Occurrences around `now` in every unmuted calendar (hidden ones still remind), with their alarms.
pub(crate) fn reminder_candidates_impl(db: &Database, now: DateTime<Utc>) -> Result<Vec<(Occurrence, Vec<i64>)>, String> {
    let conn = db.lock_db();
    let ids: Vec<String> = {
        let mut stmt = conn.prepare("SELECT id FROM calendars WHERE reminders_muted = 0").map_err(err)?;
        let rows = stmt.query_map([], |r| r.get(0)).map_err(err)?.collect::<Result<Vec<String>, _>>().map_err(err)?;
        rows
    };
    let occurrences = occurrences_in(&conn, now - Duration::days(2), now + Duration::days(8), Some(&ids))?;
    let mut alarms: HashMap<String, Vec<i64>> = HashMap::new();
    let mut out = Vec::new();
    for o in occurrences {
        let list = match alarms.get(&o.event_id) {
            Some(l) => l.clone(),
            None => {
                let l = load_alarms(&conn, &o.event_id)?;
                alarms.insert(o.event_id.clone(), l.clone());
                l
            }
        };
        if !list.is_empty() {
            out.push((o, list));
        }
    }
    Ok(out)
}

pub(crate) fn sent_reminders_impl(db: &Database) -> Result<HashSet<SentKey>, String> {
    let conn = db.lock_db();
    let mut stmt = conn.prepare("SELECT event_id, occurrence_start, minutes_before FROM event_reminders_sent").map_err(err)?;
    let rows = stmt
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(err)?
        .collect::<Result<HashSet<SentKey>, _>>()
        .map_err(err);
    rows
}

/// True when this call recorded the reminder, false if it was already recorded.
pub(crate) fn mark_reminder_sent_impl(db: &Database, key: &SentKey) -> Result<bool, String> {
    let conn = db.lock_db();
    let n = conn
        .execute(
            "INSERT OR IGNORE INTO event_reminders_sent (event_id, occurrence_start, minutes_before) VALUES (?1, ?2, ?3)",
            params![key.0, key.1, key.2],
        )
        .map_err(err)?;
    Ok(n == 1)
}

pub(crate) fn prune_reminders_impl(db: &Database) -> Result<(), String> {
    let conn = db.lock_db();
    conn.execute("DELETE FROM event_reminders_sent WHERE sent_at < datetime('now', '-30 days')", []).map(|_| ()).map_err(err)
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

    pub(super) fn subscription_cal(db: &Database) -> String {
        cal(db);
        let id = uuid::Uuid::new_v4().to_string();
        db.lock_db()
            .execute(
                "INSERT INTO calendars (id, name, color, source, refresh_minutes, sort_order) VALUES (?1, 'Feed', '#10b981', 'subscription', 60, 5)",
                params![id],
            )
            .unwrap();
        id
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

    fn titles_and_starts(db: &Database, from: &str, to: &str) -> Vec<(String, String)> {
        list(db, from, to).into_iter().map(|o| (o.title, o.start)).collect()
    }

    fn weekly(db: &Database, c: &str, rule: &str) -> String {
        zoned_row(db, c, "Europe/Berlin", "2026-10-05T09:00:00", "2026-10-05T09:30:00", Some(rule))
    }

    #[test]
    fn editing_one_slot_creates_an_override() {
        let db = temp_db();
        let c = cal(&db);
        let id = weekly(&db, &c, "FREQ=WEEKLY;BYDAY=MO");
        let patch = EventPatch {
            title: Some("Moved".into()),
            times: Some(timed("2026-10-12T08:00:00Z", "2026-10-12T08:30:00Z")),
            ..Default::default()
        };
        let d = update_event_impl(&db, &id, Some("2026-10-12T09:00:00".into()), Scope::This, patch).unwrap();
        assert_eq!(d.event.recurrence_id.as_deref(), Some("2026-10-12T09:00:00"));
        assert_eq!(
            titles_and_starts(&db, "2026-10-05T00:00:00Z", "2026-10-20T00:00:00Z"),
            vec![
                ("T".to_string(), "2026-10-05T07:00:00Z".to_string()),
                ("Moved".to_string(), "2026-10-12T08:00:00Z".to_string()),
                ("T".to_string(), "2026-10-19T07:00:00Z".to_string()),
            ]
        );
        update_event_impl(&db, &id, Some("2026-10-12T09:00:00".into()), Scope::This, EventPatch { title: Some("Again".into()), ..Default::default() }).unwrap();
        let rows: i64 = db.lock_db().query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 2, "the second edit reuses the override");
    }

    #[test]
    fn moving_the_whole_series_by_a_day_moves_rule_and_exceptions() {
        let db = temp_db();
        let c = cal(&db);
        let id = weekly(&db, &c, "FREQ=WEEKLY;BYDAY=MO");
        delete_event_impl(&db, &id, Some("2026-10-12T09:00:00".into()), Scope::This).unwrap();
        let patch = EventPatch { times: Some(timed("2026-10-20T07:00:00Z", "2026-10-20T07:30:00Z")), ..Default::default() };
        update_event_impl(&db, &id, Some("2026-10-19T09:00:00".into()), Scope::All, patch).unwrap();
        let row = get_event_impl(&db, &id).unwrap().event;
        assert_eq!(row.dtstart, "2026-10-06T09:00:00");
        assert_eq!(row.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=TU"));
        assert_eq!(row.exdates, vec!["2026-10-13T09:00:00".to_string()]);
        let starts: Vec<String> = list(&db, "2026-10-05T00:00:00Z", "2026-10-21T00:00:00Z").into_iter().map(|o| o.start).collect();
        assert_eq!(starts, vec!["2026-10-06T07:00:00Z", "2026-10-20T07:00:00Z"]);
    }

    #[test]
    fn editing_following_slots_splits_a_counted_series() {
        let db = temp_db();
        let c = cal(&db);
        let id = weekly(&db, &c, "FREQ=WEEKLY;BYDAY=MO;COUNT=5");
        let tail = update_event_impl(&db, &id, Some("2026-10-19T09:00:00".into()), Scope::Following, EventPatch { title: Some("New".into()), ..Default::default() }).unwrap();
        let titles: Vec<String> = list(&db, "2026-10-01T00:00:00Z", "2026-11-10T00:00:00Z").into_iter().map(|o| o.title).collect();
        assert_eq!(titles, vec!["T", "T", "New", "New", "New"]);
        let master = get_event_impl(&db, &id).unwrap().event;
        assert_eq!(master.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T065959Z"));
        assert_eq!(tail.event.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO;COUNT=3"));
        assert_ne!(tail.event.uid, master.uid);
    }

    #[test]
    fn deleting_this_following_and_all() {
        let db = temp_db();
        let c = cal(&db);
        let id = weekly(&db, &c, "FREQ=WEEKLY;BYDAY=MO");
        let starts = |db: &Database| -> Vec<String> { list(db, "2026-10-01T00:00:00Z", "2026-10-27T00:00:00Z").into_iter().map(|o| o.start).collect() };
        delete_event_impl(&db, &id, Some("2026-10-12T09:00:00".into()), Scope::This).unwrap();
        assert_eq!(starts(&db), vec!["2026-10-05T07:00:00Z", "2026-10-19T07:00:00Z", "2026-10-26T08:00:00Z"]);
        delete_event_impl(&db, &id, Some("2026-10-19T09:00:00".into()), Scope::Following).unwrap();
        assert_eq!(starts(&db), vec!["2026-10-05T07:00:00Z"]);
        delete_event_impl(&db, &id, None, Scope::All).unwrap();
        let rows: i64 = db.lock_db().query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn deleting_an_override_hides_its_slot() {
        let db = temp_db();
        let c = cal(&db);
        let id = weekly(&db, &c, "FREQ=WEEKLY;BYDAY=MO");
        let ov = update_event_impl(&db, &id, Some("2026-10-12T09:00:00".into()), Scope::This, EventPatch { title: Some("X".into()), ..Default::default() }).unwrap();
        delete_event_impl(&db, &ov.event.id, None, Scope::This).unwrap();
        let starts: Vec<String> = list(&db, "2026-10-01T00:00:00Z", "2026-10-20T00:00:00Z").into_iter().map(|o| o.start).collect();
        assert_eq!(starts, vec!["2026-10-05T07:00:00Z", "2026-10-19T07:00:00Z"]);
    }

    #[test]
    fn moving_an_event_in_a_foreign_zone_keeps_its_zone() {
        let db = temp_db();
        let c = cal(&db);
        let id = zoned_row(&db, &c, "America/New_York", "2026-10-15T10:00:00", "2026-10-15T11:00:00", None);
        let d = move_occurrence_impl(&db, &id, None, timed("2026-10-15T15:00:00Z", "2026-10-15T16:00:00Z"), Scope::All).unwrap();
        assert_eq!(d.event.tzid.as_deref(), Some("America/New_York"));
        assert_eq!((d.event.dtstart.as_str(), d.event.dtend.as_str()), ("2026-10-15T11:00:00", "2026-10-15T12:00:00"));
    }

    #[test]
    fn a_single_event_can_become_a_series_and_change_calendar() {
        let db = temp_db();
        let c = cal(&db);
        let other = create_calendar_impl(&db, "Other", "#123456").unwrap();
        let d = create_event_impl(&db, input(&c, "Gym", timed("2026-10-15T16:00:00Z", "2026-10-15T17:00:00Z"))).unwrap();
        let patch = EventPatch { rrule: Some("FREQ=DAILY;COUNT=3".into()), calendar_id: Some(other.id.clone()), ..Default::default() };
        update_event_impl(&db, &d.event.id, None, Scope::All, patch).unwrap();
        let occ = list(&db, "2026-10-15T00:00:00Z", "2026-10-20T00:00:00Z");
        assert_eq!(occ.len(), 3);
        assert!(occ.iter().all(|o| o.calendar_id == other.id));
    }

    #[test]
    fn overrides_move_with_a_shifted_series() {
        let db = temp_db();
        let c = cal(&db);
        let id = weekly(&db, &c, "FREQ=WEEKLY;BYDAY=MO");
        update_event_impl(&db, &id, Some("2026-10-12T09:00:00".into()), Scope::This, EventPatch { title: Some("Solo".into()), ..Default::default() }).unwrap();
        let patch = EventPatch { times: Some(timed("2026-10-20T07:00:00Z", "2026-10-20T07:30:00Z")), ..Default::default() };
        update_event_impl(&db, &id, Some("2026-10-19T09:00:00".into()), Scope::All, patch).unwrap();
        assert_eq!(
            titles_and_starts(&db, "2026-10-05T00:00:00Z", "2026-10-15T00:00:00Z"),
            vec![("T".to_string(), "2026-10-06T07:00:00Z".to_string()), ("Solo".to_string(), "2026-10-13T07:00:00Z".to_string())]
        );
    }

    #[test]
    fn switching_a_series_to_all_day_keeps_its_past_and_exceptions() {
        let db = temp_db();
        let c = cal(&db);
        let id = weekly(&db, &c, "FREQ=WEEKLY;BYDAY=MO");
        delete_event_impl(&db, &id, Some("2026-10-12T09:00:00".into()), Scope::This).unwrap();
        update_event_impl(&db, &id, Some("2026-10-26T09:00:00".into()), Scope::This, EventPatch { title: Some("Solo".into()), ..Default::default() }).unwrap();
        let all_day = EventTimes { all_day: true, start: "2026-10-19".into(), end: "2026-10-20".into() };
        update_event_impl(&db, &id, Some("2026-10-19T09:00:00".into()), Scope::All, EventPatch { times: Some(all_day), ..Default::default() }).unwrap();
        let row = get_event_impl(&db, &id).unwrap().event;
        assert!(row.all_day);
        assert_eq!((row.dtstart.as_str(), row.dtend.as_str(), row.tzid.as_deref()), ("2026-10-05", "2026-10-06", None));
        assert_eq!(row.exdates, vec!["2026-10-12".to_string()]);
        let occ = list(&db, "2026-10-01T00:00:00Z", "2026-10-27T00:00:00Z");
        let slots: Vec<(&str, &str, bool)> = occ.iter().map(|o| (o.start.as_str(), o.title.as_str(), o.all_day)).collect();
        assert_eq!(slots, vec![("2026-10-05", "T", true), ("2026-10-19", "T", true), ("2026-10-26", "Solo", true)]);

        update_event_impl(&db, &id, Some("2026-10-19".into()), Scope::All, EventPatch { times: Some(timed("2026-10-19T07:00:00Z", "2026-10-19T07:30:00Z")), ..Default::default() }).unwrap();
        let row = get_event_impl(&db, &id).unwrap().event;
        assert!(!row.all_day && row.dtstart.starts_with("2026-10-05T"));
        assert_eq!(row.exdates, vec![format!("2026-10-12{}", &row.dtstart[10..])]);
        let titles: Vec<String> = list(&db, "2026-10-01T00:00:00Z", "2026-10-27T00:00:00Z").into_iter().map(|o| o.title).collect();
        assert_eq!(titles, vec!["T", "T", "Solo"]);
    }

    #[test]
    fn a_moved_override_lands_where_a_series_edit_puts_it() {
        for (scope, first) in [(Scope::All, "2026-10-05T09:00:00Z"), (Scope::Following, "2026-10-05T07:00:00Z")] {
            let db = temp_db();
            let c = cal(&db);
            let id = weekly(&db, &c, "FREQ=WEEKLY;BYDAY=MO");
            let key = Some("2026-10-12T09:00:00".to_string());
            let moved = EventPatch { times: Some(timed("2026-10-12T08:00:00Z", "2026-10-12T08:30:00Z")), ..Default::default() };
            let ov = update_event_impl(&db, &id, key.clone(), Scope::This, moved).unwrap();
            let patch = EventPatch {
                title: Some("Moved".into()),
                times: Some(timed("2026-10-12T09:00:00Z", "2026-10-12T09:30:00Z")),
                ..Default::default()
            };
            update_event_impl(&db, &ov.event.id, key, scope, patch).unwrap();
            let occ = list(&db, "2026-10-05T00:00:00Z", "2026-10-20T00:00:00Z");
            let starts: Vec<&str> = occ.iter().map(|o| o.start.as_str()).collect();
            assert_eq!(starts, vec![first, "2026-10-12T09:00:00Z", "2026-10-19T09:00:00Z"], "{:?}", scope);
            assert_eq!(occ[1].title, "Moved", "{:?}", scope);
        }
    }

    #[test]
    fn overrides_follow_a_split_and_a_following_delete() {
        let db = temp_db();
        let c = cal(&db);
        let id = weekly(&db, &c, "FREQ=WEEKLY;BYDAY=MO");
        update_event_impl(&db, &id, Some("2026-10-26T09:00:00".into()), Scope::This, EventPatch { title: Some("Solo".into()), ..Default::default() }).unwrap();
        let tail = update_event_impl(&db, &id, Some("2026-10-19T09:00:00".into()), Scope::Following, EventPatch { title: Some("New".into()), ..Default::default() }).unwrap();
        let ov_uid: String = db.lock_db().query_row("SELECT uid FROM events WHERE recurrence_id = '2026-10-26T09:00:00'", [], |r| r.get(0)).unwrap();
        assert_eq!(ov_uid, tail.event.uid);
        let titles: Vec<String> = list(&db, "2026-10-26T00:00:00Z", "2026-10-28T00:00:00Z").into_iter().map(|o| o.title).collect();
        assert_eq!(titles, vec!["Solo"]);
        delete_event_impl(&db, &tail.event.id, Some("2026-10-19T09:00:00".into()), Scope::Following).unwrap();
        let rows: i64 = db.lock_db().query_row("SELECT COUNT(*) FROM events WHERE recurrence_id IS NOT NULL", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 0);
    }

    #[test]
    fn dropping_the_rule_removes_overrides() {
        let db = temp_db();
        let c = cal(&db);
        let id = weekly(&db, &c, "FREQ=WEEKLY;BYDAY=MO");
        update_event_impl(&db, &id, Some("2026-10-12T09:00:00".into()), Scope::This, EventPatch { title: Some("Solo".into()), ..Default::default() }).unwrap();
        update_event_impl(&db, &id, None, Scope::All, EventPatch { clear_rrule: true, ..Default::default() }).unwrap();
        let rows: i64 = db.lock_db().query_row("SELECT COUNT(*) FROM events", [], |r| r.get(0)).unwrap();
        assert_eq!(rows, 1);
        assert_eq!(list(&db, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z").len(), 1);
    }

    #[test]
    fn until_moves_with_a_shifted_series() {
        let db = temp_db();
        let c = cal(&db);
        let id = weekly(&db, &c, "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261026T235959Z");
        let patch = EventPatch { times: Some(timed("2026-10-06T07:00:00Z", "2026-10-06T07:30:00Z")), ..Default::default() };
        update_event_impl(&db, &id, None, Scope::All, patch).unwrap();
        let row = get_event_impl(&db, &id).unwrap().event;
        assert_eq!(row.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=TU;UNTIL=20261027T235959Z"));
        let starts: Vec<String> = list(&db, "2026-10-20T00:00:00Z", "2026-11-05T00:00:00Z").into_iter().map(|o| o.start).collect();
        assert_eq!(starts, vec!["2026-10-20T07:00:00Z", "2026-10-27T08:00:00Z"]);
    }

    const OUTLOOK: &str = include_str!("fixtures/outlook_windows_tz.ics");
    const GOOGLE: &str = include_str!("fixtures/google_weekly.ics");

    #[test]
    fn importing_twice_updates_instead_of_duplicating() {
        let db = temp_db();
        let c = cal(&db);
        assert_eq!(import_ics_impl(&db, &c, OUTLOOK).unwrap(), ImportResult { imported: 1, updated: 0, skipped: 0 });
        assert_eq!(import_ics_impl(&db, &c, OUTLOOK).unwrap(), ImportResult { imported: 0, updated: 1, skipped: 0 });
        let occ = list(&db, "2026-10-20T00:00:00Z", "2026-10-21T00:00:00Z");
        assert_eq!(occ.len(), 1);
        assert_eq!(occ[0].start, "2026-10-20T12:00:00Z");
        let detail = get_event_impl(&db, &occ[0].event_id).unwrap();
        assert_eq!(detail.alarms, vec![15]);
        assert_eq!(detail.attendees.len(), 1);
        assert_eq!(detail.event.organizer_email.as_deref(), Some("robin@contoso.example"));
    }

    #[test]
    fn older_sequences_are_skipped() {
        let db = temp_db();
        let c = cal(&db);
        import_ics_impl(&db, &c, OUTLOOK).unwrap();
        let older = OUTLOOK.replace("SEQUENCE:2", "SEQUENCE:1");
        assert_eq!(import_ics_impl(&db, &c, &older).unwrap(), ImportResult { imported: 0, updated: 0, skipped: 1 });
    }

    const INVITED: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:inv-1\r\nSEQUENCE:3\r\nDTSTART:20261020T070000Z\r\nDTEND:20261020T080000Z\r\nRRULE:FREQ=WEEKLY;COUNT=3\r\nSUMMARY:Review\r\nORGANIZER:mailto:boss@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    #[test]
    fn local_edits_of_a_received_invitation_keep_the_organizer_sequence() {
        let db = temp_db();
        let c = cal(&db);
        import_ics_impl(&db, &c, INVITED).unwrap();
        let id: String = db.lock_db().query_row("SELECT id FROM events WHERE uid = 'inv-1'", [], |r| r.get(0)).unwrap();
        let renamed = update_event_impl(&db, &id, None, Scope::All, EventPatch { title: Some("Review (prep)".into()), ..Default::default() }).unwrap();
        assert_eq!(renamed.event.sequence, 3);
        delete_event_impl(&db, &id, Some("2026-10-27T07:00:00".into()), Scope::This).unwrap();
        assert_eq!(get_event_impl(&db, &id).unwrap().event.sequence, 3);
    }

    #[test]
    fn local_events_still_count_their_edits() {
        let db = temp_db();
        let c = cal(&db);
        let d = create_event_impl(&db, input(&c, "Dentist", timed("2026-10-15T07:00:00Z", "2026-10-15T08:00:00Z"))).unwrap();
        let renamed = update_event_impl(&db, &d.event.id, None, Scope::All, EventPatch { title: Some("Dentist!".into()), ..Default::default() }).unwrap();
        assert_eq!(renamed.event.sequence, 1);
    }

    #[test]
    fn imported_series_expand_and_export_back() {
        let db = temp_db();
        let c = cal(&db);
        import_ics_impl(&db, &c, GOOGLE).unwrap();
        let starts: Vec<String> = list(&db, "2026-10-05T00:00:00Z", "2026-10-27T00:00:00Z").into_iter().map(|o| o.start).collect();
        assert_eq!(starts, vec!["2026-10-05T07:00:00Z", "2026-10-19T07:00:00Z", "2026-10-26T08:00:00Z"]);
        let (name, ics) = export_ics_impl(&db, &c).unwrap();
        assert_eq!(name, "Mine");
        let parsed = parse_calendar(&ics);
        assert_eq!(parsed.events.len(), 1);
        assert_eq!(parsed.events[0].exdates, vec!["2026-10-12T09:00:00".to_string()]);
        assert!(ics.contains("X-GOOGLE-CONFERENCE:https://meet.google.com/abc-defg-hij"));
    }

    #[test]
    fn files_without_events_are_rejected() {
        let db = temp_db();
        let c = cal(&db);
        assert_eq!(import_ics_impl(&db, &c, "BEGIN:VCALENDAR\nEND:VCALENDAR\n").unwrap_err(), "calendar.errors.noEvents");
    }

    #[test]
    fn reminder_log_is_idempotent_and_hidden_calendars_still_remind() {
        let db = temp_db();
        let hidden = create_calendar_impl(&db, "Hidden", "#00ff00").unwrap();
        let now = Utc::now();
        create_event_impl(
            &db,
            EventInput { alarms: vec![10], ..input(&hidden.id, "Call", timed(&fmt_utc(now + Duration::minutes(5)), &fmt_utc(now + Duration::minutes(35)))) },
        )
        .unwrap();
        update_calendar_impl(&db, &hidden.id, CalendarPatch { visible: Some(false), ..Default::default() }).unwrap();
        let cands = reminder_candidates_impl(&db, now).unwrap();
        assert_eq!(cands.len(), 1);
        assert_eq!(cands[0].1, vec![10]);
        let key = (cands[0].0.event_id.clone(), cands[0].0.start.clone(), 10);
        assert!(mark_reminder_sent_impl(&db, &key).unwrap());
        assert!(!mark_reminder_sent_impl(&db, &key).unwrap(), "a second mark is a no-op");
        assert!(sent_reminders_impl(&db).unwrap().contains(&key));
        prune_reminders_impl(&db).unwrap();
        assert!(sent_reminders_impl(&db).unwrap().contains(&key), "fresh entries survive pruning");
    }

    const OVERRIDE_FEED: &str = "BEGIN:VCALENDAR
VERSION:2.0
BEGIN:VEVENT
UID:standup@test
DTSTART;TZID=Europe/Berlin:20261005T090000
DTEND;TZID=Europe/Berlin:20261005T093000
RRULE:FREQ=WEEKLY;COUNT=3
SUMMARY:Standup
END:VEVENT
BEGIN:VEVENT
UID:standup@test
RECURRENCE-ID;TZID=Europe/Berlin:20261012T090000
DTSTART;TZID=Europe/Berlin:20261012T110000
DTEND;TZID=Europe/Berlin:20261012T113000
SUMMARY:Standup (moved)
END:VEVENT
END:VCALENDAR
";

    #[test]
    fn override_rows_from_files_replace_their_slot() {
        let db = temp_db();
        let c = cal(&db);
        assert_eq!(import_ics_impl(&db, &c, OVERRIDE_FEED).unwrap().imported, 2);
        let got: Vec<(String, String)> =
            list(&db, "2026-10-01T00:00:00Z", "2026-10-25T00:00:00Z").into_iter().map(|o| (o.start, o.title)).collect();
        assert_eq!(
            got,
            vec![
                ("2026-10-05T07:00:00Z".to_string(), "Standup".to_string()),
                ("2026-10-12T09:00:00Z".to_string(), "Standup (moved)".to_string()),
                ("2026-10-19T07:00:00Z".to_string(), "Standup".to_string()),
            ]
        );
    }

    #[test]
    fn absurd_durations_do_not_break_imports() {
        let db = temp_db();
        let c = cal(&db);
        let text = "BEGIN:VCALENDAR
BEGIN:VEVENT
UID:long@test
DTSTART:20261015T090000Z
DURATION:P9223372036854775807W
SUMMARY:Broken
BEGIN:VALARM
TRIGGER:-P9223372036854775807D
ACTION:DISPLAY
END:VALARM
END:VEVENT
END:VCALENDAR
";
        assert_eq!(import_ics_impl(&db, &c, text).unwrap().imported, 1);
        let occ = list(&db, "2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z");
        assert_eq!(occ.len(), 1);
        assert_eq!(occ[0].start, "2026-10-15T09:00:00Z");
        assert!(get_event_impl(&db, &occ[0].event_id).unwrap().alarms.is_empty());
    }

    #[test]
    fn muted_calendars_do_not_remind() {
        let db = temp_db();
        let c = cal(&db);
        let now = Utc::now();
        create_event_impl(
            &db,
            EventInput { alarms: vec![10], ..input(&c, "Call", timed(&fmt_utc(now + Duration::minutes(5)), &fmt_utc(now + Duration::minutes(35)))) },
        )
        .unwrap();
        assert_eq!(reminder_candidates_impl(&db, now).unwrap().len(), 1);
        let muted = update_calendar_impl(&db, &c, CalendarPatch { reminders_muted: Some(true), ..Default::default() }).unwrap();
        assert!(muted.reminders_muted);
        assert!(reminder_candidates_impl(&db, now).unwrap().is_empty());
    }

    #[test]
    fn subscriptions_take_only_known_intervals_and_never_become_default() {
        let db = temp_db();
        let local = cal(&db);
        let sub = subscription_cal(&db);
        let listed = list_calendars_impl(&db, "Mine").unwrap();
        let feed = listed.iter().find(|c| c.id == sub).unwrap();
        assert!(feed.read_only);
        assert_eq!(feed.refresh_minutes, Some(60));
        assert!(!listed.iter().find(|c| c.id == local).unwrap().read_only);
        let set = |id: &str, patch: CalendarPatch| update_calendar_impl(&db, id, patch);
        assert_eq!(set(&sub, CalendarPatch { refresh_minutes: Some(360), ..Default::default() }).unwrap().refresh_minutes, Some(360));
        assert_eq!(set(&sub, CalendarPatch { refresh_minutes: Some(7), ..Default::default() }).unwrap_err(), "calendar.errors.invalidSettings");
        assert_eq!(set(&local, CalendarPatch { refresh_minutes: Some(60), ..Default::default() }).unwrap_err(), "calendar.errors.invalidSettings");
        assert_eq!(set(&sub, CalendarPatch { is_default: Some(true), ..Default::default() }).unwrap_err(), "calendar.errors.readOnly");
    }

    #[test]
    fn the_last_local_calendar_stays_even_beside_subscriptions() {
        let db = temp_db();
        let local = cal(&db);
        let sub = subscription_cal(&db);
        assert_eq!(delete_calendar_impl(&db, &local).unwrap_err(), "calendar.errors.lastCalendar");
        let second = create_calendar_impl(&db, "Work", "#ef4444").unwrap();
        assert!(!second.is_default);
        delete_calendar_impl(&db, &local).unwrap();
        let after = list_calendars_impl(&db, "Mine").unwrap();
        assert!(after.iter().find(|c| c.id == second.id).unwrap().is_default, "the default moves to a local calendar");
        assert!(!after.iter().find(|c| c.id == sub).unwrap().is_default);
        assert!(delete_calendar_impl(&db, &sub).unwrap().read_only);
    }

    #[test]
    fn a_first_local_calendar_beside_subscriptions_becomes_default() {
        let db = temp_db();
        let id = uuid::Uuid::new_v4().to_string();
        db.lock_db()
            .execute("INSERT INTO calendars (id, name, color, source, refresh_minutes) VALUES (?1, 'Feed', '#10b981', 'subscription', 60)", params![id])
            .unwrap();
        assert!(create_calendar_impl(&db, "Mine", "#3b82f6").unwrap().is_default);
    }

    #[test]
    fn subscribed_calendars_reject_every_write() {
        let db = temp_db();
        let local = cal(&db);
        let sub = subscription_cal(&db);
        let ev = zoned_row(&db, &sub, "Europe/Berlin", "2026-10-15T09:00:00", "2026-10-15T10:00:00", None);
        let ro = "calendar.errors.readOnly";
        let times = timed("2026-10-15T08:00:00Z", "2026-10-15T09:00:00Z");
        assert_eq!(create_event_impl(&db, input(&sub, "x", times.clone())).unwrap_err(), ro);
        let rename = EventPatch { title: Some("y".into()), ..Default::default() };
        assert_eq!(update_event_impl(&db, &ev, None, Scope::All, rename).unwrap_err(), ro);
        assert_eq!(move_occurrence_impl(&db, &ev, None, times.clone(), Scope::All).unwrap_err(), ro);
        assert_eq!(delete_event_impl(&db, &ev, None, Scope::All).unwrap_err(), ro);
        assert_eq!(import_ics_impl(&db, &sub, OVERRIDE_FEED).unwrap_err(), ro);
        let mine = create_event_impl(&db, input(&local, "Mine", times)).unwrap().event.id;
        let into_feed = EventPatch { calendar_id: Some(sub.clone()), ..Default::default() };
        assert_eq!(update_event_impl(&db, &mine, None, Scope::All, into_feed).unwrap_err(), ro);
        let occ = list(&db, "2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z");
        assert!(occ.iter().find(|o| o.event_id == ev).unwrap().read_only);
        assert!(!occ.iter().find(|o| o.event_id == mine).unwrap().read_only);
        assert!(get_event_impl(&db, &ev).unwrap().read_only);
    }

    const EV_A: &str = "BEGIN:VEVENT\nUID:a@test\nDTSTART:20261015T090000Z\nDTEND:20261015T100000Z\nSUMMARY:A\n\
BEGIN:VALARM\nTRIGGER:-PT10M\nACTION:DISPLAY\nEND:VALARM\nEND:VEVENT\n";
    const EV_B: &str = "BEGIN:VEVENT\nUID:b@test\nDTSTART:20261016T090000Z\nDTEND:20261016T100000Z\nSUMMARY:B\nEND:VEVENT\n";

    fn feed(events: &str) -> ParsedCalendar {
        parse_calendar(&format!("BEGIN:VCALENDAR\nVERSION:2.0\n{}END:VCALENDAR\n", events))
    }

    fn meta(hash: &str) -> FeedMeta {
        FeedMeta { etag: Some("\"v1\"".into()), hash: hash.into() }
    }

    fn feed_titles(db: &Database) -> Vec<(String, String)> {
        list(db, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z").into_iter().map(|o| (o.event_id, o.title)).collect()
    }

    #[test]
    fn mirroring_adds_updates_and_removes_by_uid() {
        let db = temp_db();
        let sub = subscription_cal(&db);
        let first = mirror_ics_impl(&db, &sub, &feed(&format!("{}{}", EV_A, EV_B)), &meta("h1")).unwrap();
        assert_eq!(first, MirrorResult { imported: 2, updated: 0, removed: 0, skipped: 0 });
        let id_a = feed_titles(&db).into_iter().find(|(_, t)| t == "A").unwrap().0;
        let changed = EV_A.replace("SUMMARY:A", "SUMMARY:A2").replace("TRIGGER:-PT10M", "TRIGGER:-PT30M");
        let second = mirror_ics_impl(&db, &sub, &feed(&changed), &meta("h2")).unwrap();
        assert_eq!(second, MirrorResult { imported: 0, updated: 1, removed: 1, skipped: 0 });
        assert_eq!(feed_titles(&db), vec![(id_a.clone(), "A2".to_string())]);
        assert_eq!(get_event_impl(&db, &id_a).unwrap().alarms, vec![30]);
        let conn = db.lock_db();
        let (hash, etag, synced, error): (String, String, Option<String>, Option<String>) = conn
            .query_row("SELECT content_hash, sync_token, last_synced_at, last_error FROM calendars WHERE id = ?1", params![sub], |r| {
                Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
            })
            .unwrap();
        assert_eq!((hash.as_str(), etag.as_str(), error), ("h2", "\"v1\"", None));
        assert!(synced.is_some());
    }

    #[test]
    fn an_empty_calendar_empties_the_mirror_but_a_non_calendar_does_not() {
        let db = temp_db();
        let sub = subscription_cal(&db);
        mirror_ics_impl(&db, &sub, &feed(EV_A), &meta("h1")).unwrap();
        assert_eq!(mirror_ics_impl(&db, &sub, &feed(""), &meta("h2")).unwrap().removed, 1);
        assert!(feed_titles(&db).is_empty());
        mirror_ics_impl(&db, &sub, &feed(EV_A), &meta("h3")).unwrap();
        let page = parse_calendar("<html><body>Sign in</body></html>");
        assert_eq!(mirror_ics_impl(&db, &sub, &page, &meta("h4")).unwrap_err(), "calendar.errors.notCalendar");
        assert_eq!(feed_titles(&db).len(), 1);
    }

    #[test]
    fn override_rows_follow_the_feed() {
        let db = temp_db();
        let sub = subscription_cal(&db);
        mirror_ics_impl(&db, &sub, &parse_calendar(OVERRIDE_FEED), &meta("h1")).unwrap();
        let moved: Vec<String> = list(&db, "2026-10-12T00:00:00Z", "2026-10-13T00:00:00Z").into_iter().map(|o| o.start).collect();
        assert_eq!(moved, vec!["2026-10-12T09:00:00Z"]);
        let master_only = OVERRIDE_FEED.split("BEGIN:VEVENT\nUID:standup@test\nRECURRENCE-ID").next().unwrap().to_string() + "END:VCALENDAR\n";
        assert_eq!(mirror_ics_impl(&db, &sub, &parse_calendar(&master_only), &meta("h2")).unwrap().removed, 1);
        let back: Vec<String> = list(&db, "2026-10-12T00:00:00Z", "2026-10-13T00:00:00Z").into_iter().map(|o| o.start).collect();
        assert_eq!(back, vec!["2026-10-12T07:00:00Z"]);
    }

    #[test]
    fn uid_less_feeds_keep_their_rows() {
        let db = temp_db();
        let sub = subscription_cal(&db);
        let ev = "BEGIN:VEVENT\nDTSTAMP:20261015T080000Z\nDTSTART:20261015T070000Z\nDTEND:20261015T080000Z\nSUMMARY:Gym\nEND:VEVENT\n";
        mirror_ics_impl(&db, &sub, &feed(ev), &meta("h1")).unwrap();
        let before = feed_titles(&db);
        let again = ev.replace("DTSTAMP:20261015T080000Z", "DTSTAMP:20261016T090000Z");
        assert_eq!(mirror_ics_impl(&db, &sub, &feed(&again), &meta("h2")).unwrap(), MirrorResult { imported: 0, updated: 1, removed: 0, skipped: 0 });
        assert_eq!(feed_titles(&db), before);
    }

    #[test]
    fn local_calendars_are_never_mirrored() {
        let db = temp_db();
        let local = cal(&db);
        assert!(mirror_ics_impl(&db, &local, &feed(EV_A), &meta("h1")).is_err());
    }

    #[test]
    fn large_feeds_mirror_in_reasonable_time() {
        let db = temp_db();
        let sub = subscription_cal(&db);
        let base = parse_utc("2026-01-01T00:00:00Z").unwrap();
        let events: String = (0..5000)
            .map(|i| {
                let start = (base + Duration::hours(i)).format("%Y%m%dT%H%M%SZ");
                format!("BEGIN:VEVENT\nUID:bulk-{}@test\nDTSTART:{}\nDURATION:PT30M\nSUMMARY:Item {}\nEND:VEVENT\n", i, start, i)
            })
            .collect();
        let parsed = feed(&events);
        let started = std::time::Instant::now();
        assert_eq!(mirror_ics_impl(&db, &sub, &parsed, &meta("h1")).unwrap().imported, 5000);
        assert!(started.elapsed() < std::time::Duration::from_secs(10), "took {:?}", started.elapsed());
    }
}
