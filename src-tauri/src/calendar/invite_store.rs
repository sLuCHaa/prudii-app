//! Invitations stored on mails: organizer updates applied on arrival, the card's
//! view and the user's answers. Pure iTIP lives in `itip.rs`.

use super::ical::{parse_calendar, ParsedEvent};
use super::invite_mail::{choose, is_calendar_part, FoundInvite, InviteCandidate};
use super::itip::{self, CancelTarget, Me};
use super::meeting::find_meeting_link;
use super::recurrence::{derive_range, expand, key_to_naive, naive_to_key, slot_shape, ExpandInput};
use super::store::{
    ensure_writable, get_calendar_settings_impl, import_ics_impl, load_alarms, occurrences_in, row_to_event, set_alarms, set_attendees,
    write_event, EVENT_COLS,
};
use super::tz::{fmt_utc, parse_utc, system_tz};
use super::{Attendee, EventRow, ImportResult, InvitationView, InviteChanges, Occurrence, TextChange, TimeChange, TimeSpan, SUBSCRIPTION};
use crate::db::Database;
use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use std::collections::HashSet;

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

struct MailInvite {
    account_id: String,
    account_email: String,
    from_email: String,
    method: Option<String>,
    ics: Option<String>,
    partstat: Option<String>,
    folder_type: Option<String>,
}

fn load_mail(conn: &Connection, mail_id: &str) -> Result<MailInvite, String> {
    conn.query_row(
        "SELECT m.account_id, a.email, m.from_email, m.invite_method, m.invite_ics, m.invite_partstat, f.folder_type
         FROM mails m JOIN accounts a ON a.id = m.account_id LEFT JOIN folders f ON f.id = m.folder_id WHERE m.id = ?1",
        params![mail_id],
        |r| {
            Ok(MailInvite {
                account_id: r.get(0)?,
                account_email: r.get(1)?,
                from_email: r.get(2)?,
                method: r.get(3)?,
                ics: r.get(4)?,
                partstat: r.get(5)?,
                folder_type: r.get(6)?,
            })
        },
    )
    .optional()
    .map_err(err)?
    .ok_or_else(|| "calendar.errors.notFound".to_string())
}

fn same(a: Option<&str>, b: &str) -> bool {
    a.is_some_and(|a| !a.trim().is_empty() && a.trim().eq_ignore_ascii_case(b.trim()))
}

/// Rows of a received invitation, all from the writable calendar holding its series.
fn known_rows(conn: &Connection, uid: &str) -> Result<Vec<EventRow>, String> {
    let sql = format!(
        "SELECT {} FROM events e JOIN calendars c ON c.id = e.calendar_id
         WHERE e.uid = ?1 AND c.source != ?2 AND e.is_organizer = 0
         ORDER BY e.recurrence_id IS NOT NULL, e.created_at",
        EVENT_COLS
    );
    let mut stmt = conn.prepare(&sql).map_err(err)?;
    let rows: Vec<EventRow> = stmt.query_map(params![uid, SUBSCRIPTION], row_to_event).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    let Some(home) = rows.first().map(|r| r.calendar_id.clone()) else { return Ok(rows) };
    Ok(rows.into_iter().filter(|r| r.calendar_id == home).collect())
}

fn attendees_of(p: &ParsedEvent) -> Vec<Attendee> {
    p.attendees.iter().map(Attendee::from).collect()
}

/// The organizer resetting me to NEEDS-ACTION is the one answer an update may change.
fn next_partstat(current: &Option<String>, me: &Me) -> Option<String> {
    match (current, me.partstat.as_deref()) {
        (Some(_), Some("needs-action")) => Some("needs-action".into()),
        _ => current.clone(),
    }
}

/// Overwrites `existing` with the organizer's version; calendar, account and
/// reminders stay. False when the new times are unusable.
fn apply_update(conn: &Connection, existing: &EventRow, p: &ParsedEvent, me: &Me) -> Result<bool, String> {
    let mut row = p.to_row(existing.id.clone(), existing.calendar_id.clone());
    row.account_id = existing.account_id.clone();
    row.my_partstat = next_partstat(&existing.my_partstat, me);
    if derive_range(&row).is_none() {
        return Ok(false);
    }
    write_event(conn, &row)?;
    set_attendees(conn, &row.id, &attendees_of(p))?;
    Ok(true)
}

/// A changed instance of a known series becomes its own override row.
fn add_override(conn: &Connection, master: &EventRow, p: &ParsedEvent, me: &Me) -> Result<bool, String> {
    if master.recurrence_id.is_some() || p.recurrence_id.is_none() || superseded(master, p.sequence) {
        return Ok(false);
    }
    let mut row = p.to_row(uuid::Uuid::new_v4().to_string(), master.calendar_id.clone());
    row.account_id = master.account_id.clone();
    row.my_partstat = next_partstat(&master.my_partstat, me);
    if derive_range(&row).is_none() {
        return Ok(false);
    }
    write_event(conn, &row)?;
    set_alarms(conn, &row.id, &load_alarms(conn, &master.id)?)?;
    set_attendees(conn, &row.id, &attendees_of(p))?;
    Ok(true)
}

/// The stored slot is newer than this invitation (or cancelled at the same version).
fn superseded(row: &EventRow, sequence: i64) -> bool {
    sequence < row.sequence || (row.status == "cancelled" && sequence <= row.sequence)
}

/// Re-reading or re-answering the same version must not undo local edits (RFC 5546 order).
fn is_newer(p: &ParsedEvent, row: &EventRow) -> bool {
    let stamps = (itip::dtstamp(&p.raw), row.ical_raw.as_deref().and_then(itip::dtstamp));
    p.sequence > row.sequence || (p.sequence == row.sequence && matches!(stamps, (Some(new), Some(old)) if new > old))
}

/// The exact slot an invitation names, else its series.
fn slot_or_series<'a>(rows: &'a [EventRow], recurrence_id: &Option<String>) -> Option<&'a EventRow> {
    rows.iter().find(|r| &r.recurrence_id == recurrence_id).or_else(|| rows.iter().find(|r| r.recurrence_id.is_none()))
}

/// A REQUEST carrying the series replaces the whole set (RFC 5546).
fn drop_stale_instances(conn: &Connection, rows: &[EventRow], master: &ParsedEvent, all: &[ParsedEvent]) -> Result<(), String> {
    let carried = |rid: &Option<String>| all.iter().any(|e| e.uid == master.uid && &e.recurrence_id == rid);
    for r in rows.iter().filter(|r| r.recurrence_id.is_some() && r.sequence <= master.sequence && !carried(&r.recurrence_id)) {
        conn.execute("DELETE FROM events WHERE id = ?1", params![r.id]).map_err(err)?;
    }
    Ok(())
}

fn apply_request(conn: &Connection, rows: &[EventRow], p: &ParsedEvent, all: &[ParsedEvent], me: &Me) -> Result<bool, String> {
    let Some(anchor) = rows.first() else { return Ok(false) };
    match rows.iter().find(|r| r.recurrence_id == p.recurrence_id) {
        Some(slot) if superseded(slot, p.sequence) || !is_newer(p, slot) => Ok(false),
        Some(slot) => {
            let applied = apply_update(conn, slot, p, me)?;
            if applied && p.recurrence_id.is_none() {
                drop_stale_instances(conn, rows, p, all)?;
            }
            Ok(applied)
        }
        None => add_override(conn, anchor, p, me),
    }
}

fn auto_update(conn: &Connection, mail: &MailInvite, p: &ParsedEvent, all: &[ParsedEvent]) -> Result<bool, String> {
    if same(p.organizer_email.as_deref(), &mail.account_email) {
        return Ok(false);
    }
    let rows = known_rows(conn, &p.uid)?;
    let Some(anchor) = rows.first() else { return Ok(false) };
    if !same(anchor.organizer_email.as_deref(), &mail.from_email) {
        return Ok(false);
    }
    apply_request(conn, &rows, p, all, &itip::find_me(p, &mail.account_email))
}

fn cancel_slot(conn: &Connection, master: &EventRow, key: &str, sequence: i64) -> Result<bool, String> {
    let (Some((_, len)), Some(start)) = (slot_shape(master), key_to_naive(master.all_day, key)) else { return Ok(false) };
    let mut row = master.clone();
    row.id = uuid::Uuid::new_v4().to_string();
    row.recurrence_id = Some(key.to_string());
    row.rrule = None;
    row.exdates.clear();
    row.rdates.clear();
    row.dtstart = naive_to_key(master.all_day, start);
    row.dtend = naive_to_key(master.all_day, start + len);
    row.status = "cancelled".into();
    row.sequence = master.sequence.max(sequence);
    if derive_range(&row).is_none() {
        return Ok(false);
    }
    write_event(conn, &row)?;
    Ok(true)
}

fn auto_cancel(conn: &Connection, mail: &MailInvite, target: &CancelTarget) -> Result<bool, String> {
    let rows = known_rows(conn, &target.uid)?;
    let Some(anchor) = rows.first() else { return Ok(false) };
    if !same(anchor.organizer_email.as_deref(), &mail.from_email) {
        return Ok(false);
    }
    let hit: Vec<&EventRow> = match &target.recurrence_id {
        None => rows.iter().collect(),
        Some(k) => rows.iter().filter(|r| r.recurrence_id.as_deref() == Some(k.as_str())).collect(),
    };
    if hit.is_empty() {
        return match &target.recurrence_id {
            Some(k) if anchor.recurrence_id.is_none() && target.sequence >= anchor.sequence => cancel_slot(conn, anchor, k, target.sequence),
            _ => Ok(false),
        };
    }
    let mut changed = false;
    for r in hit.into_iter().filter(|r| r.status != "cancelled" && target.sequence >= r.sequence) {
        let mut row = r.clone();
        row.status = "cancelled".into();
        row.sequence = row.sequence.max(target.sequence);
        write_event(conn, &row)?;
        changed = true;
    }
    Ok(changed)
}

/// Updates and cancellations take effect when the mail is read, but only from the
/// organizer the stored event names; anything else waits for the user's answer.
pub(crate) fn process_mail_impl(db: &Database, mail_id: &str) -> Result<bool, String> {
    let conn = db.lock_db();
    let mail = load_mail(&conn, mail_id)?;
    let (Some(method), Some(ics)) = (mail.method.as_deref(), mail.ics.as_deref()) else { return Ok(false) };
    if method != "REQUEST" && method != "CANCEL" {
        return Ok(false);
    }
    // The provider's spam verdict outranks the sender check.
    if matches!(mail.folder_type.as_deref(), Some("spam" | "trash")) {
        return Ok(false);
    }
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut changed = false;
    if method == "REQUEST" {
        let events = parse_calendar(ics).events;
        for p in &events {
            changed |= auto_update(&tx, &mail, p, &events)?;
        }
    } else {
        for target in itip::cancel_targets(ics) {
            changed |= auto_cancel(&tx, &mail, &target)?;
        }
    }
    tx.commit().map_err(err)?;
    Ok(changed)
}

/// Records what a body fetch found (None clears it) and applies the organizer's changes.
pub(crate) fn store_invite(db: &Database, mail_id: &str, found: Option<&FoundInvite>) {
    {
        let conn = db.lock_db();
        // Backfills store thousands of bodies; most have nothing to clear.
        let written = match found {
            Some(f) => conn.execute("UPDATE mails SET invite_method = ?1, invite_ics = ?2 WHERE id = ?3", params![f.method, f.ics, mail_id]),
            None => conn.execute("UPDATE mails SET invite_method = NULL, invite_ics = NULL WHERE id = ?1 AND invite_ics IS NOT NULL", params![mail_id]),
        };
        if let Err(e) = written {
            log::warn!("invitation of {} not recorded: {}", mail_id, e);
            return;
        }
    }
    if found.is_none() {
        return;
    }
    // Runs inside body fetches, whose body write must still happen.
    match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| process_mail_impl(db, mail_id))) {
        Ok(Ok(true)) => super::notify_changed(),
        Ok(Ok(false)) => {}
        Ok(Err(e)) => log::warn!("invitation of {} not applied: {}", mail_id, e),
        Err(_) => log::error!("invitation of {} not applied: processing panicked", mail_id),
    }
}

const CONFLICT_TITLES: usize = 3;
// Kept invite files of mails read before detection existed; real ones are a few KB.
const MAX_LEGACY_BYTES: u64 = 1024 * 1024;

fn span_of(o: &Occurrence) -> TimeSpan {
    TimeSpan { all_day: o.all_day, start: o.start.clone(), end: o.end.clone() }
}

fn slots(row: &EventRow, from: DateTime<Utc>, to: DateTime<Utc>) -> Vec<Occurrence> {
    let none: HashSet<String> = HashSet::new();
    let input = ExpandInput { color: "", has_attendees: false, read_only: false, skip_keys: &none };
    expand(row, from, to, system_tz(), &input)
}

fn first_slot(row: &EventRow) -> Option<Occurrence> {
    let start = parse_utc(&derive_range(row)?.0)?;
    slots(row, start - Duration::days(1), start + Duration::days(2)).into_iter().next()
}

fn shown_slot(row: &EventRow, now: DateTime<Utc>) -> Option<Occurrence> {
    slots(row, now, now + Duration::days(400)).into_iter().next().or_else(|| first_slot(row))
}

struct Snapshot {
    title: String,
    location: String,
    span: Option<TimeSpan>,
}

fn snapshot(row: &EventRow) -> Snapshot {
    Snapshot { title: row.title.clone(), location: row.location.clone(), span: first_slot(row).map(|o| span_of(&o)) }
}

fn diff(old: &Snapshot, new: &Snapshot) -> InviteChanges {
    let text = |a: &str, b: &str| (a.trim() != b.trim()).then(|| TextChange { old: a.trim().to_string(), new: b.trim().to_string() });
    InviteChanges {
        time: match (&old.span, &new.span) {
            (Some(a), Some(b)) if a != b => Some(TimeChange { old: a.clone(), new: b.clone() }),
            _ => None,
        },
        location: text(&old.location, &new.location),
        title: text(&old.title, &new.title),
    }
}

/// The newest earlier version of the same event among this account's invitations.
fn previous_version(conn: &Connection, mail_id: &str, account_id: &str, p: &ParsedEvent) -> Result<Option<ParsedEvent>, String> {
    // Stored texts are folded; a long UID only has its start on the UID line.
    let probe: String = p.uid.chars().take(40).collect();
    let mut stmt = conn
        .prepare("SELECT invite_ics FROM mails WHERE account_id = ?1 AND id != ?2 AND invite_method = 'REQUEST' AND instr(invite_ics, ?3) > 0")
        .map_err(err)?;
    let texts: Vec<String> = stmt.query_map(params![account_id, mail_id, probe], |r| r.get(0)).map_err(err)?.collect::<Result<_, _>>().map_err(err)?;
    Ok(texts
        .iter()
        .flat_map(|t| parse_calendar(t).events)
        .filter(|e| e.uid == p.uid && e.recurrence_id == p.recurrence_id && e.sequence < p.sequence)
        .max_by_key(|e| e.sequence))
}

fn conflicts(conn: &Connection, when: &TimeSpan, own: &HashSet<String>, now: DateTime<Utc>) -> Result<(Vec<String>, usize), String> {
    if when.all_day {
        return Ok((Vec::new(), 0));
    }
    let (Some(s), Some(e)) = (parse_utc(&when.start), parse_utc(&when.end)) else { return Ok((Vec::new(), 0)) };
    if e <= now || e <= s {
        return Ok((Vec::new(), 0));
    }
    let titles: Vec<String> = occurrences_in(conn, s, e, None)?
        .into_iter()
        .filter(|o| !o.all_day && o.status != "cancelled" && o.my_partstat.as_deref() != Some("declined") && !own.contains(&o.event_id))
        .filter(|o| matches!((parse_utc(&o.start), parse_utc(&o.end)), (Some(os), Some(oe)) if os < e && oe > s))
        .map(|o| o.title)
        .collect();
    let count = titles.len();
    Ok((titles.into_iter().take(CONFLICT_TITLES).collect(), count))
}

fn build_view(conn: &Connection, mail_id: &str, mail: &MailInvite, now: DateTime<Utc>) -> Result<Option<InvitationView>, String> {
    let (Some(method), Some(ics)) = (mail.method.as_deref(), mail.ics.as_deref()) else { return Ok(None) };
    if method == "REPLY" {
        return Ok(None);
    }
    let parsed = parse_calendar(ics);
    let Some(p) = itip::primary_event(&parsed) else { return Ok(None) };
    let invite_row = p.to_row(String::new(), String::new());
    let Some(slot) = shown_slot(&invite_row, now) else { return Ok(None) };
    let when = span_of(&slot);
    let rows = known_rows(conn, &p.uid)?;
    let exact = rows.iter().find(|r| r.recurrence_id == p.recurrence_id);
    let anchor = slot_or_series(&rows, &p.recurrence_id);
    // An applied cancellation is current; only a newer invitation outdates it.
    let outdated = anchor.is_some_and(|r| if method == "CANCEL" { p.sequence < r.sequence } else { superseded(r, p.sequence) });
    let base = match exact.filter(|r| r.sequence < p.sequence) {
        Some(r) => Some(snapshot(r)),
        None => previous_version(conn, mail_id, &mail.account_id, p)?.map(|e| snapshot(&e.to_row(String::new(), String::new()))),
    };
    let own: HashSet<String> = rows.iter().map(|r| r.id.clone()).collect();
    let (titles, conflict_count) = conflicts(conn, &when, &own, now)?;
    Ok(Some(InvitationView {
        mail_id: mail_id.to_string(),
        method: method.to_string(),
        uid: p.uid.clone(),
        recurrence_id: p.recurrence_id.clone(),
        title: p.title.clone(),
        location: p.location.clone(),
        description: p.description.clone(),
        when,
        tzid: p.tzid.clone(),
        rrule: p.rrule.clone(),
        organizer_name: p.organizer_name.clone(),
        organizer_email: p.organizer_email.clone(),
        attendee_count: p.attendees.len(),
        meeting_link: find_meeting_link(&[p.location.as_str(), p.description.as_str()]),
        organizer_is_me: same(p.organizer_email.as_deref(), &mail.account_email),
        my_partstat: anchor.and_then(|r| r.my_partstat.clone()).or_else(|| mail.partstat.clone()),
        rsvp: itip::find_me(p, &mail.account_email).rsvp,
        event_id: anchor.map(|r| r.id.clone()),
        calendar_id: anchor.map(|r| r.calendar_id.clone()),
        stored_status: anchor.map(|r| r.status.clone()),
        outdated,
        updated: method == "REQUEST" && base.is_some(),
        changes: base.map(|b| diff(&b, &snapshot(&invite_row))).unwrap_or_default(),
        conflicts: titles,
        conflict_count,
        event_count: parsed.events.len(),
    }))
}

/// Mails whose body was stored before detection existed keep the invitation as a file.
fn legacy_invite(db: &Database, mail_id: &str) -> Option<FoundInvite> {
    let files: Vec<(String, Option<String>, Option<String>)> = {
        let conn = db.lock_db();
        let mut stmt = conn.prepare("SELECT filename, mime_type, local_path FROM attachments WHERE mail_id = ?1").ok()?;
        let rows = stmt.query_map(params![mail_id], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?))).ok()?.filter_map(Result::ok).collect();
        rows
    };
    let candidates = files
        .into_iter()
        .filter(|(name, mime, _)| is_calendar_part(mime.as_deref().unwrap_or(""), Some(name)))
        .filter_map(|(name, _, path)| {
            let path = std::path::PathBuf::from(path?);
            if std::fs::metadata(&path).ok()?.len() > MAX_LEGACY_BYTES {
                return None;
            }
            let text = std::fs::read_to_string(&path).ok()?;
            Some(InviteCandidate { text, method_param: None, inline: name == "unnamed" })
        })
        .collect();
    choose(candidates)
}

pub(crate) fn invitation_view_impl(db: &Database, mail_id: &str, now: DateTime<Utc>) -> Result<Option<InvitationView>, String> {
    let unchecked = {
        let conn = db.lock_db();
        load_mail(&conn, mail_id)?.ics.is_none()
    };
    if unchecked {
        let Some(found) = legacy_invite(db, mail_id) else { return Ok(None) };
        store_invite(db, mail_id, Some(&found));
    }
    let conn = db.lock_db();
    let mail = load_mail(&conn, mail_id)?;
    build_view(&conn, mail_id, &mail, now)
}

const ANSWERS: [&str; 3] = ["accepted", "tentative", "declined"];

/// What `respond_invitation` sends once the answer is saved.
#[derive(Debug, Clone, PartialEq)]
pub struct ReplyDraft {
    pub account_id: String,
    pub to: String,
    pub ics: String,
}

/// Saves my answer (declining a new invitation creates nothing) and prepares the
/// REPLY. The answer is stored before anything is sent.
pub(crate) fn respond_impl(
    db: &Database,
    mail_id: &str,
    partstat: &str,
    calendar_id: &str,
    comment: Option<&str>,
    want_reply: bool,
    now: DateTime<Utc>,
) -> Result<Option<ReplyDraft>, String> {
    if !ANSWERS.contains(&partstat) {
        return Err("calendar.invite.errors.invalid".into());
    }
    let settings = get_calendar_settings_impl(db);
    let conn = db.lock_db();
    let mail = load_mail(&conn, mail_id)?;
    let ics = match (mail.method.as_deref(), mail.ics.as_deref()) {
        (Some("REQUEST"), Some(ics)) => ics.to_string(),
        _ => return Err("calendar.invite.errors.notRequest".into()),
    };
    let parsed = parse_calendar(&ics);
    let p = itip::primary_event(&parsed).ok_or("calendar.errors.noEvents")?.clone();
    if want_reply && p.organizer_email.is_none() {
        return Err("calendar.invite.errors.noOrganizer".into());
    }
    let rows = known_rows(&conn, &p.uid)?;
    if slot_or_series(&rows, &p.recurrence_id).is_some_and(|r| superseded(r, p.sequence)) {
        return Err("calendar.invite.errors.outdated".into());
    }
    let me = itip::find_me(&p, &mail.account_email);
    let ours: Vec<&ParsedEvent> = parsed.events.iter().filter(|e| e.uid == p.uid).collect();
    let tx = conn.unchecked_transaction().map_err(err)?;
    match rows.first() {
        None if partstat == "declined" => {}
        None => {
            ensure_writable(&tx, calendar_id)?;
            for e in &ours {
                let mut row = e.to_row(uuid::Uuid::new_v4().to_string(), calendar_id.to_string());
                row.my_partstat = Some(partstat.to_string());
                row.account_id = Some(mail.account_id.clone());
                if derive_range(&row).is_none() {
                    continue;
                }
                write_event(&tx, &row)?;
                let alarms: Vec<i64> = if !e.alarms.is_empty() {
                    e.alarms.clone()
                } else if row.all_day {
                    Vec::new()
                } else {
                    settings.default_reminder_minutes.into_iter().collect()
                };
                set_alarms(&tx, &row.id, &alarms)?;
                set_attendees(&tx, &row.id, &attendees_of(e))?;
            }
        }
        Some(anchor) => {
            for e in &ours {
                apply_request(&tx, &known_rows(&tx, &e.uid)?, e, &parsed.events, &me)?;
            }
            let cal = anchor.calendar_id.clone();
            match &p.recurrence_id {
                None => tx.execute("UPDATE events SET my_partstat = ?1 WHERE calendar_id = ?2 AND uid = ?3", params![partstat, cal, p.uid]),
                Some(k) => tx.execute(
                    "UPDATE events SET my_partstat = ?1 WHERE calendar_id = ?2 AND uid = ?3 AND recurrence_id = ?4",
                    params![partstat, cal, p.uid, k],
                ),
            }
            .map_err(err)?;
        }
    }
    tx.execute("UPDATE mails SET invite_partstat = ?1 WHERE id = ?2", params![partstat, mail_id]).map_err(err)?;
    tx.commit().map_err(err)?;
    Ok(p.organizer_email.clone().filter(|_| want_reply).map(|to| ReplyDraft {
        account_id: mail.account_id.clone(),
        to,
        ics: itip::build_reply(&ics, &p, &me, partstat, comment, now),
    }))
}

pub(crate) fn add_published_impl(db: &Database, mail_id: &str, calendar_id: &str) -> Result<ImportResult, String> {
    let ics = {
        let conn = db.lock_db();
        let mail = load_mail(&conn, mail_id)?;
        match (mail.method.as_deref(), mail.ics) {
            (Some("PUBLISH"), Some(ics)) => ics,
            _ => return Err("calendar.invite.errors.invalid".into()),
        }
    };
    import_ics_impl(db, calendar_id, &ics)
}

/// A cancelled instance leaves an exception on its series; a cancelled event goes entirely.
pub(crate) fn remove_cancelled_impl(db: &Database, mail_id: &str) -> Result<(), String> {
    let conn = db.lock_db();
    let mail = load_mail(&conn, mail_id)?;
    let ics = match (mail.method.as_deref(), mail.ics.as_deref()) {
        (Some("CANCEL"), Some(ics)) => ics.to_string(),
        _ => return Err("calendar.invite.errors.invalid".into()),
    };
    let tx = conn.unchecked_transaction().map_err(err)?;
    let (mut named, mut applied) = (false, false);
    for target in itip::cancel_targets(&ics) {
        let rows = known_rows(&tx, &target.uid)?;
        if rows.is_empty() {
            continue;
        }
        match &target.recurrence_id {
            None => {
                named = true;
                for r in rows.iter().filter(|r| target.sequence >= r.sequence) {
                    tx.execute("DELETE FROM events WHERE id = ?1", params![r.id]).map_err(err)?;
                    applied = true;
                }
            }
            Some(k) => {
                let slot = rows.iter().find(|r| r.recurrence_id.as_deref() == Some(k.as_str()));
                let master = rows.iter().find(|r| r.recurrence_id.is_none());
                named |= slot.is_some() || master.is_some();
                if let Some(r) = slot.filter(|r| target.sequence >= r.sequence) {
                    tx.execute("DELETE FROM events WHERE id = ?1", params![r.id]).map_err(err)?;
                    applied = true;
                }
                if let Some(master) = master.filter(|m| target.sequence >= m.sequence) {
                    applied = true;
                    if !master.exdates.contains(k) {
                        let mut row = master.clone();
                        row.exdates.push(k.clone());
                        row.exdates.sort();
                        write_event(&tx, &row)?;
                    }
                }
            }
        }
    }
    if named && !applied {
        return Err("calendar.invite.errors.outdated".into());
    }
    tx.commit().map_err(err)
}

/// Mails whose updates should land without being opened: unread bodies in the
/// inbox from people tied to my upcoming events.
pub(crate) fn relevant_unfetched_mails_impl(db: &Database, account_id: &str, now: DateTime<Utc>, limit: usize) -> Result<Vec<String>, String> {
    let conn = db.lock_db();
    let mut stmt = conn
        .prepare(
            "SELECT m.id FROM mails m JOIN folders f ON f.id = m.folder_id
             WHERE m.account_id = ?1 AND f.folder_type = 'inbox' AND m.body_text = '' AND m.body_html = ''
               AND m.from_email != '' AND LOWER(m.from_email) IN (
                 SELECT LOWER(e.organizer_email) FROM events e JOIN calendars c ON c.id = e.calendar_id
                  WHERE c.source != ?2 AND e.is_organizer = 0 AND e.organizer_email IS NOT NULL
                    AND (e.range_end_utc IS NULL OR e.range_end_utc >= ?3)
                 UNION
                 SELECT LOWER(a.email) FROM event_attendees a JOIN events e ON e.id = a.event_id JOIN calendars c ON c.id = e.calendar_id
                  WHERE c.source != ?2 AND e.is_organizer = 1 AND (e.range_end_utc IS NULL OR e.range_end_utc >= ?3))
             ORDER BY m.date DESC LIMIT ?4",
        )
        .map_err(err)?;
    let since = fmt_utc(now - Duration::days(1));
    let ids = stmt
        .query_map(params![account_id, SUBSCRIPTION, since, limit as i64], |r| r.get(0))
        .map_err(err)?
        .collect::<Result<Vec<String>, _>>()
        .map_err(err);
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::content_line::fold_line;
    use crate::calendar::ical::parse_calendar;
    use crate::calendar::store::{
        create_event_impl, import_ics_impl, list_calendars_impl, list_occurrences_impl, load_alarms, mirror_ics_impl, update_event_impl,
    };
    use crate::calendar::{EventInput, EventPatch, EventTimes, FeedMeta, Scope};
    use chrono::TimeZone;

    const ROBIN: &str = "ORGANIZER;CN=Robin:mailto:robin@example.com";
    const OPEN: &str = "ATTENDEE;CN=Sam;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:sam@example.com";
    const YES: &str = "ATTENDEE;CN=Sam;PARTSTAT=ACCEPTED;RSVP=TRUE:mailto:sam@example.com";

    fn temp_db() -> Database {
        Database::new(std::env::temp_dir().join(format!("prudii-invite-{}", uuid::Uuid::new_v4()))).unwrap()
    }

    /// Account `acc` (Sam@Example.com), its inbox and the default calendar.
    fn setup() -> (Database, String) {
        let db = temp_db();
        {
            let conn = db.lock_db();
            conn.execute(
                "INSERT INTO accounts (id, email, display_name, provider, imap_host, smtp_host) VALUES ('acc', 'Sam@Example.com', 'Sam', 'imap', 'imap.example.com', 'smtp.example.com')",
                [],
            )
            .unwrap();
            conn.execute("INSERT INTO folders (id, account_id, name, folder_type, path) VALUES ('inbox', 'acc', 'INBOX', 'inbox', 'INBOX')", []).unwrap();
        }
        let cal = list_calendars_impl(&db, "Mine").unwrap().remove(0).id;
        (db, cal)
    }

    fn ics(method: &str, events: &[Vec<String>]) -> String {
        let mut lines = vec!["BEGIN:VCALENDAR".to_string(), "VERSION:2.0".into(), format!("METHOD:{}", method)];
        for e in events {
            lines.push("BEGIN:VEVENT".into());
            lines.extend(e.iter().cloned());
            lines.push("END:VEVENT".into());
        }
        lines.push("END:VCALENDAR".into());
        lines.iter().map(|l| fold_line(l)).collect()
    }

    /// One VEVENT by Robin: one hour from `start` (UTC), my ATTENDEE line, extra lines.
    fn vevent(uid: &str, seq: i64, start: &str, me: &str, extra: &[&str]) -> Vec<String> {
        let mut v = vec![
            format!("UID:{}", uid),
            format!("SEQUENCE:{}", seq),
            format!("DTSTART:{}", start),
            "DURATION:PT1H".into(),
            "SUMMARY:Review".into(),
            ROBIN.into(),
            me.into(),
        ];
        v.extend(extra.iter().map(|s| s.to_string()));
        v
    }

    fn mail(db: &Database, id: &str, from: &str, text: &str) {
        let method = parse_calendar(text).method;
        db.lock_db()
            .execute(
                "INSERT INTO mails (id, account_id, folder_id, from_email, invite_method, invite_ics) VALUES (?1, 'acc', 'inbox', ?2, ?3, ?4)",
                params![id, from, method, text],
            )
            .unwrap();
    }

    /// The invitation as if accepted earlier: imported, answered, tied to `acc`.
    fn known(db: &Database, cal: &str, text: &str, partstat: &str) {
        import_ics_impl(db, cal, text).unwrap();
        db.lock_db()
            .execute(
                "UPDATE events SET my_partstat = ?1, account_id = 'acc' WHERE calendar_id = ?2 AND organizer_email IS NOT NULL AND my_partstat IS NULL",
                params![partstat, cal],
            )
            .unwrap();
    }

    fn event(db: &Database, uid: &str, rid: Option<&str>) -> EventRow {
        db.lock_db()
            .query_row(
                &format!("SELECT {} FROM events e WHERE e.uid = ?1 AND IFNULL(e.recurrence_id, '') = IFNULL(?2, '')", EVENT_COLS),
                params![uid, rid],
                row_to_event,
            )
            .unwrap()
    }

    fn count(db: &Database, uid: &str) -> i64 {
        db.lock_db().query_row("SELECT COUNT(*) FROM events WHERE uid = ?1", params![uid], |r| r.get(0)).unwrap()
    }

    #[test]
    fn organizer_updates_apply_and_keep_my_answer_and_reminders() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", OPEN, &["LOCATION:Room 1"])]), "accepted");
        let id = event(&db, "r1", None).id;
        set_alarms(&db.lock_db(), &id, &[30]).unwrap();
        mail(&db, "m2", "Robin@example.com", &ics("REQUEST", &[vevent("r1", 1, "20261020T080000Z", YES, &["LOCATION:Room 2"])]));
        assert!(process_mail_impl(&db, "m2").unwrap());
        let row = event(&db, "r1", None);
        assert_eq!((row.id.as_str(), row.dtstart.as_str(), row.location.as_str(), row.sequence), (id.as_str(), "2026-10-20T08:00:00", "Room 2", 1));
        assert_eq!(row.my_partstat.as_deref(), Some("accepted"));
        assert_eq!(load_alarms(&db.lock_db(), &id).unwrap(), vec![30]);
    }

    #[test]
    fn a_reset_to_needs_action_reopens_my_answer() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", YES, &[])]), "accepted");
        mail(&db, "m2", "robin@example.com", &ics("REQUEST", &[vevent("r1", 1, "20261020T090000Z", OPEN, &[])]));
        assert!(process_mail_impl(&db, "m2").unwrap());
        assert_eq!(event(&db, "r1", None).my_partstat.as_deref(), Some("needs-action"));
    }

    #[test]
    fn older_foreign_and_unknown_updates_change_nothing() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 2, "20261020T070000Z", YES, &[])]), "accepted");
        mail(&db, "old", "robin@example.com", &ics("REQUEST", &[vevent("r1", 1, "20261020T090000Z", YES, &[])]));
        mail(&db, "spoof", "mallory@example.com", &ics("REQUEST", &[vevent("r1", 5, "20261020T090000Z", YES, &[])]));
        mail(&db, "new", "robin@example.com", &ics("REQUEST", &[vevent("r9", 0, "20261020T090000Z", OPEN, &[])]));
        for id in ["old", "spoof", "new"] {
            assert!(!process_mail_impl(&db, id).unwrap(), "{id}");
        }
        assert_eq!(event(&db, "r1", None).dtstart, "2026-10-20T07:00:00");
        assert_eq!(count(&db, "r9"), 0);
    }

    #[test]
    fn local_edits_do_not_block_the_next_organizer_update() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", YES, &[])]), "accepted");
        let id = event(&db, "r1", None).id;
        update_event_impl(&db, &id, None, Scope::All, EventPatch { title: Some("My notes".into()), ..Default::default() }).unwrap();
        mail(&db, "m2", "robin@example.com", &ics("REQUEST", &[vevent("r1", 1, "20261020T090000Z", YES, &[])]));
        assert!(process_mail_impl(&db, "m2").unwrap());
        assert_eq!(event(&db, "r1", None).dtstart, "2026-10-20T09:00:00");
    }

    #[test]
    fn cancelling_one_slot_adds_a_single_cancelled_override() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("s1", 0, "20261020T070000Z", YES, &["RRULE:FREQ=WEEKLY;COUNT=4"])]), "accepted");
        let cancel = ics(
            "CANCEL",
            &[vec!["UID:s1".into(), "SEQUENCE:0".into(), "RECURRENCE-ID:20261027T070000Z".into(), "DTSTART:20261027T070000Z".into(), ROBIN.into()]],
        );
        mail(&db, "c1", "robin@example.com", &cancel);
        assert!(process_mail_impl(&db, "c1").unwrap());
        assert!(!process_mail_impl(&db, "c1").unwrap());
        assert_eq!(count(&db, "s1"), 2);
        assert_eq!(event(&db, "s1", Some("2026-10-27T07:00:00")).status, "cancelled");
        assert_eq!(event(&db, "s1", None).status, "confirmed");
    }

    #[test]
    fn cancelling_the_series_marks_every_row_even_without_a_start() {
        let (db, cal) = setup();
        let series = ics(
            "REQUEST",
            &[
                vevent("s1", 0, "20261020T070000Z", YES, &["RRULE:FREQ=WEEKLY;COUNT=4"]),
                vevent("s1", 0, "20261027T090000Z", YES, &["RECURRENCE-ID:20261027T070000Z"]),
            ],
        );
        known(&db, &cal, &series, "accepted");
        mail(&db, "c1", "robin@example.com", &ics("CANCEL", &[vec!["UID:s1".into(), "SEQUENCE:1".into(), ROBIN.into()]]));
        assert!(process_mail_impl(&db, "c1").unwrap());
        let statuses: Vec<String> = db
            .lock_db()
            .prepare("SELECT status FROM events WHERE uid = 's1'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(statuses, vec!["cancelled", "cancelled"]);
    }

    #[test]
    fn an_old_cancellation_does_not_undo_a_newer_invitation() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 2, "20261020T070000Z", YES, &[])]), "accepted");
        mail(&db, "c1", "robin@example.com", &ics("CANCEL", &[vevent("r1", 1, "20261020T070000Z", YES, &[])]));
        assert!(!process_mail_impl(&db, "c1").unwrap());
        assert_eq!(event(&db, "r1", None).status, "confirmed");
    }

    #[test]
    fn subscribed_copies_and_my_own_invitations_are_left_alone() {
        let (db, cal) = setup();
        db.lock_db()
            .execute("INSERT INTO calendars (id, name, color, source, refresh_minutes) VALUES ('feed', 'Feed', '#10b981', 'subscription', 60)", [])
            .unwrap();
        let feed = ics("PUBLISH", &[vevent("f1", 0, "20261020T070000Z", YES, &[])]);
        mirror_ics_impl(&db, "feed", &parse_calendar(&feed), &FeedMeta::default()).unwrap();
        mail(&db, "m1", "robin@example.com", &ics("REQUEST", &[vevent("f1", 3, "20261020T090000Z", YES, &[])]));
        assert!(!process_mail_impl(&db, "m1").unwrap());
        assert_eq!(event(&db, "f1", None).dtstart, "2026-10-20T07:00:00");

        let mine = |seq: i64| ics("REQUEST", &[vec!["UID:o1".into(), format!("SEQUENCE:{}", seq), "DTSTART:20261020T070000Z".into(), "ORGANIZER:mailto:sam@example.com".into()]]);
        known(&db, &cal, &mine(0), "accepted");
        mail(&db, "m2", "sam@example.com", &mine(1));
        assert!(!process_mail_impl(&db, "m2").unwrap());
    }

    #[test]
    fn store_invite_records_applies_and_clears() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", YES, &[])]), "accepted");
        db.lock_db().execute("INSERT INTO mails (id, account_id, folder_id, from_email) VALUES ('bare', 'acc', 'inbox', 'robin@example.com')", []).unwrap();
        let text = ics("REQUEST", &[vevent("r1", 1, "20261020T090000Z", YES, &[])]);
        let cols = || {
            db.lock_db()
                .query_row("SELECT invite_method, invite_ics FROM mails WHERE id = 'bare'", [], |r| {
                    Ok((r.get::<_, Option<String>>(0)?, r.get::<_, Option<String>>(1)?))
                })
                .unwrap()
        };
        store_invite(&db, "bare", Some(&FoundInvite { method: "REQUEST".into(), ics: text.clone() }));
        assert_eq!(cols(), (Some("REQUEST".to_string()), Some(text)));
        assert_eq!(event(&db, "r1", None).dtstart, "2026-10-20T09:00:00");
        store_invite(&db, "bare", None);
        assert_eq!(cols(), (None, None));
    }

    fn series(db: &Database, cal: &str) {
        known(db, cal, &ics("REQUEST", &[vevent("s1", 0, "20261020T070000Z", YES, &["RRULE:FREQ=WEEKLY;COUNT=4"])]), "accepted");
    }

    fn cancel_all(seq: i64) -> String {
        ics("CANCEL", &[vec!["UID:s1".into(), format!("SEQUENCE:{}", seq), ROBIN.into()]])
    }

    #[test]
    fn an_older_update_arriving_after_a_cancellation_does_not_revive_the_series() {
        let (db, cal) = setup();
        series(&db, &cal);
        mail(&db, "c1", "robin@example.com", &cancel_all(1));
        mail(&db, "old", "robin@example.com", &ics("REQUEST", &[vevent("s1", 0, "20261020T080000Z", YES, &["RRULE:FREQ=WEEKLY;COUNT=4"])]));
        assert!(process_mail_impl(&db, "c1").unwrap());
        assert!(!process_mail_impl(&db, "old").unwrap());
        assert_eq!(event(&db, "s1", None).status, "cancelled");
        assert_eq!(event(&db, "s1", None).dtstart, "2026-10-20T07:00:00");
    }

    #[test]
    fn a_cancellation_with_the_same_sequence_is_not_undone_by_an_update() {
        let (db, cal) = setup();
        series(&db, &cal);
        mail(&db, "c1", "robin@example.com", &cancel_all(0));
        mail(&db, "same", "robin@example.com", &ics("REQUEST", &[vevent("s1", 0, "20261020T080000Z", YES, &["RRULE:FREQ=WEEKLY;COUNT=4"])]));
        assert!(process_mail_impl(&db, "c1").unwrap());
        assert!(!process_mail_impl(&db, "same").unwrap());
        assert_eq!(event(&db, "s1", None).status, "cancelled");
    }

    #[test]
    fn an_older_update_does_not_revive_a_cancelled_slot() {
        let (db, cal) = setup();
        series(&db, &cal);
        let cancel = ics(
            "CANCEL",
            &[vec!["UID:s1".into(), "SEQUENCE:1".into(), "RECURRENCE-ID:20261027T070000Z".into(), "DTSTART:20261027T070000Z".into(), ROBIN.into()]],
        );
        let older = ics("REQUEST", &[vevent("s1", 0, "20261027T090000Z", YES, &["RECURRENCE-ID:20261027T070000Z"])]);
        mail(&db, "c1", "robin@example.com", &cancel);
        mail(&db, "old", "robin@example.com", &older);
        assert!(process_mail_impl(&db, "c1").unwrap());
        assert!(!process_mail_impl(&db, "old").unwrap());
        assert_eq!(event(&db, "s1", Some("2026-10-27T07:00:00")).status, "cancelled");
    }

    #[test]
    fn a_newer_invitation_restores_a_cancelled_event() {
        let (db, cal) = setup();
        series(&db, &cal);
        mail(&db, "c1", "robin@example.com", &cancel_all(1));
        mail(&db, "new", "robin@example.com", &ics("REQUEST", &[vevent("s1", 2, "20261020T080000Z", YES, &["RRULE:FREQ=WEEKLY;COUNT=4"])]));
        assert!(process_mail_impl(&db, "c1").unwrap());
        assert!(process_mail_impl(&db, "new").unwrap());
        assert_eq!(event(&db, "s1", None).status, "confirmed");
        assert_eq!(event(&db, "s1", None).dtstart, "2026-10-20T08:00:00");
    }

    #[test]
    fn a_changed_instance_of_a_known_series_becomes_an_override() {
        let (db, cal) = setup();
        series(&db, &cal);
        let master = event(&db, "s1", None).id;
        set_alarms(&db.lock_db(), &master, &[15]).unwrap();
        mail(&db, "m2", "robin@example.com", &ics("REQUEST", &[vevent("s1", 0, "20261027T090000Z", YES, &["RECURRENCE-ID:20261027T070000Z"])]));
        assert!(process_mail_impl(&db, "m2").unwrap());
        assert_eq!(count(&db, "s1"), 2);
        let o = event(&db, "s1", Some("2026-10-27T07:00:00"));
        assert_eq!((o.dtstart.as_str(), o.my_partstat.as_deref()), ("2026-10-27T09:00:00", Some("accepted")));
        assert_eq!(load_alarms(&db.lock_db(), &o.id).unwrap(), vec![15]);
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 16, 0, 0, 0).unwrap()
    }

    #[test]
    fn a_new_request_shows_time_conflicts_and_my_rsvp() {
        let (db, cal) = setup();
        let times = EventTimes { all_day: false, start: "2026-10-20T07:30:00Z".into(), end: "2026-10-20T08:30:00Z".into() };
        create_event_impl(
            &db,
            EventInput { calendar_id: cal.clone(), title: "Dentist".into(), description: String::new(), location: String::new(), times, rrule: None, alarms: vec![] },
        )
        .unwrap();
        mail(&db, "m1", "robin@example.com", &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", OPEN, &["LOCATION:https://meet.google.com/abc-defg-hij"])]));
        let v = invitation_view_impl(&db, "m1", now()).unwrap().unwrap();
        assert_eq!((v.method.as_str(), v.title.as_str()), ("REQUEST", "Review"));
        assert_eq!(v.when, TimeSpan { all_day: false, start: "2026-10-20T07:00:00Z".into(), end: "2026-10-20T08:00:00Z".into() });
        assert_eq!(v.tzid.as_deref(), Some("UTC"));
        assert_eq!((v.event_id.clone(), v.my_partstat.clone(), v.rsvp, v.outdated, v.updated), (None, None, true, false, false));
        assert_eq!((v.conflicts.clone(), v.conflict_count), (vec!["Dentist".to_string()], 1));
        assert_eq!(v.organizer_email.as_deref(), Some("robin@example.com"));
        assert_eq!(v.meeting_link.as_deref(), Some("https://meet.google.com/abc-defg-hij"));
        assert_eq!((v.attendee_count, v.event_count, v.organizer_is_me), (1, 1, false));
    }

    #[test]
    fn an_update_lists_changes_against_the_earlier_invitation() {
        let (db, _) = setup();
        let uid = format!("040000008200E00074C5B7101A82E008{}", "0".repeat(80));
        mail(&db, "m1", "robin@example.com", &ics("REQUEST", &[vevent(&uid, 0, "20261020T070000Z", OPEN, &["LOCATION:Room 1"])]));
        mail(&db, "m2", "robin@example.com", &ics("REQUEST", &[vevent(&uid, 1, "20261020T080000Z", OPEN, &["LOCATION:Room 2"])]));
        let v = invitation_view_impl(&db, "m2", now()).unwrap().unwrap();
        assert!(v.updated);
        let time = v.changes.time.unwrap();
        assert_eq!((time.old.start.as_str(), time.new.start.as_str()), ("2026-10-20T07:00:00Z", "2026-10-20T08:00:00Z"));
        assert_eq!(v.changes.location, Some(TextChange { old: "Room 1".into(), new: "Room 2".into() }));
        assert_eq!(v.changes.title, None);
        assert!(!invitation_view_impl(&db, "m1", now()).unwrap().unwrap().updated);
    }

    #[test]
    fn outdated_requests_replies_and_my_own_echoes() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 3, "20261020T070000Z", YES, &[])]), "accepted");
        mail(&db, "old", "robin@example.com", &ics("REQUEST", &[vevent("r1", 2, "20261020T070000Z", OPEN, &[])]));
        let v = invitation_view_impl(&db, "old", now()).unwrap().unwrap();
        assert!(v.outdated);
        assert_eq!(v.my_partstat.as_deref(), Some("accepted"));
        mail(&db, "reply", "kim@example.com", &ics("REPLY", &[vevent("r1", 3, "20261020T070000Z", YES, &[])]));
        assert_eq!(invitation_view_impl(&db, "reply", now()).unwrap(), None);
        let mine = ics("REQUEST", &[vec!["UID:o1".into(), "DTSTART:20261020T070000Z".into(), "ORGANIZER:mailto:sam@example.com".into()]]);
        mail(&db, "echo", "sam@example.com", &mine);
        assert!(invitation_view_impl(&db, "echo", now()).unwrap().unwrap().organizer_is_me);
    }

    #[test]
    fn mails_from_before_detection_fall_back_to_the_saved_invite_file() {
        let (db, _) = setup();
        let path = db.data_dir.join("legacy-invite.ics");
        std::fs::write(&path, ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", OPEN, &[])])).unwrap();
        {
            let conn = db.lock_db();
            conn.execute("INSERT INTO mails (id, account_id, folder_id, from_email) VALUES ('legacy', 'acc', 'inbox', 'robin@example.com')", []).unwrap();
            conn.execute(
                "INSERT INTO attachments (id, mail_id, filename, mime_type, local_path) VALUES ('a1', 'legacy', 'unnamed', 'text/calendar', ?1)",
                params![path.to_string_lossy()],
            )
            .unwrap();
        }
        assert_eq!(invitation_view_impl(&db, "legacy", now()).unwrap().unwrap().title, "Review");
        let stored: Option<String> = db.lock_db().query_row("SELECT invite_method FROM mails WHERE id = 'legacy'", [], |r| r.get(0)).unwrap();
        assert_eq!(stored.as_deref(), Some("REQUEST"));
        assert_eq!(invitation_view_impl(&db, "missing", now()), Err("calendar.errors.notFound".to_string()));
    }

    #[test]
    fn accepting_creates_the_event_with_my_answer_and_the_default_reminder() {
        let (db, cal) = setup();
        mail(&db, "m1", "robin@example.com", &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", OPEN, &[])]));
        let draft = respond_impl(&db, "m1", "accepted", &cal, Some("See you"), true, now()).unwrap().unwrap();
        assert_eq!((draft.account_id.as_str(), draft.to.as_str()), ("acc", "robin@example.com"));
        let flat = draft.ics.replace("\r\n ", "");
        assert!(flat.contains("METHOD:REPLY") && flat.contains("PARTSTAT=ACCEPTED") && flat.contains("COMMENT:See you"));
        let row = event(&db, "r1", None);
        assert_eq!((row.calendar_id.as_str(), row.my_partstat.as_deref(), row.account_id.as_deref()), (cal.as_str(), Some("accepted"), Some("acc")));
        assert_eq!(load_alarms(&db.lock_db(), &row.id).unwrap(), vec![15]);
        let v = invitation_view_impl(&db, "m1", now()).unwrap().unwrap();
        assert_eq!((v.event_id, v.my_partstat.as_deref()), (Some(row.id.clone()), Some("accepted")));
    }

    #[test]
    fn declining_creates_nothing_but_is_remembered_and_later_dims_an_accepted_event() {
        let (db, cal) = setup();
        mail(&db, "m1", "robin@example.com", &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", OPEN, &[])]));
        assert_eq!(respond_impl(&db, "m1", "declined", &cal, None, false, now()).unwrap(), None);
        assert_eq!(count(&db, "r1"), 0);
        assert_eq!(invitation_view_impl(&db, "m1", now()).unwrap().unwrap().my_partstat.as_deref(), Some("declined"));
        respond_impl(&db, "m1", "accepted", &cal, None, false, now()).unwrap();
        respond_impl(&db, "m1", "accepted", &cal, None, false, now()).unwrap();
        respond_impl(&db, "m1", "declined", &cal, None, false, now()).unwrap();
        assert_eq!(count(&db, "r1"), 1);
        assert_eq!(event(&db, "r1", None).my_partstat.as_deref(), Some("declined"));
    }

    #[test]
    fn answers_cover_the_series_and_its_exceptions() {
        let (db, cal) = setup();
        let series = ics(
            "REQUEST",
            &[
                vevent("s1", 0, "20261020T070000Z", OPEN, &["RRULE:FREQ=WEEKLY;COUNT=4"]),
                vevent("s1", 0, "20261027T090000Z", OPEN, &["RECURRENCE-ID:20261027T070000Z"]),
            ],
        );
        mail(&db, "m1", "robin@example.com", &series);
        respond_impl(&db, "m1", "tentative", &cal, None, false, now()).unwrap();
        let answers: Vec<Option<String>> = db
            .lock_db()
            .prepare("SELECT my_partstat FROM events WHERE uid = 's1'")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .map(Result::unwrap)
            .collect();
        assert_eq!(answers, vec![Some("tentative".to_string()), Some("tentative".to_string())]);
    }

    #[test]
    fn answers_are_refused_for_wrong_input() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 3, "20261020T070000Z", YES, &[])]), "accepted");
        mail(&db, "old", "robin@example.com", &ics("REQUEST", &[vevent("r1", 2, "20261020T070000Z", OPEN, &[])]));
        mail(&db, "cancel", "robin@example.com", &ics("CANCEL", &[vevent("r1", 4, "20261020T070000Z", OPEN, &[])]));
        mail(&db, "anon", "robin@example.com", &ics("REQUEST", &[vec!["UID:a1".into(), "DTSTART:20261020T070000Z".into()]]));
        let refused = |id: &str, partstat: &str, reply: bool| respond_impl(&db, id, partstat, &cal, None, reply, now()).unwrap_err();
        assert_eq!(refused("old", "accepted", false), "calendar.invite.errors.outdated");
        assert_eq!(refused("cancel", "accepted", false), "calendar.invite.errors.notRequest");
        assert_eq!(refused("old", "maybe", false), "calendar.invite.errors.invalid");
        assert_eq!(refused("anon", "accepted", true), "calendar.invite.errors.noOrganizer");
    }

    #[test]
    fn answering_applies_an_update_the_sender_check_held_back() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", YES, &[])]), "accepted");
        mail(&db, "m2", "calendar-notification@google.com", &ics("REQUEST", &[vevent("r1", 1, "20261020T090000Z", YES, &[])]));
        assert!(!process_mail_impl(&db, "m2").unwrap());
        let v = invitation_view_impl(&db, "m2", now()).unwrap().unwrap();
        assert!(v.updated && v.changes.time.is_some());
        respond_impl(&db, "m2", "accepted", &cal, None, false, now()).unwrap();
        let row = event(&db, "r1", None);
        assert_eq!((row.dtstart.as_str(), row.sequence, row.my_partstat.as_deref()), ("2026-10-20T09:00:00", 1, Some("accepted")));
    }

    #[test]
    fn published_events_are_added_and_cancelled_ones_removed() {
        let (db, cal) = setup();
        mail(&db, "pub", "robin@example.com", &ics("PUBLISH", &[vevent("p1", 0, "20261021T070000Z", OPEN, &[])]));
        assert_eq!(add_published_impl(&db, "pub", &cal).unwrap().imported, 1);
        assert!(invitation_view_impl(&db, "pub", now()).unwrap().unwrap().event_id.is_some());

        known(&db, &cal, &ics("REQUEST", &[vevent("s1", 0, "20261020T070000Z", YES, &["RRULE:FREQ=WEEKLY;COUNT=4"])]), "accepted");
        let one = ics("CANCEL", &[vec!["UID:s1".into(), "RECURRENCE-ID:20261027T070000Z".into(), "DTSTART:20261027T070000Z".into(), ROBIN.into()]]);
        mail(&db, "one", "robin@example.com", &one);
        process_mail_impl(&db, "one").unwrap();
        remove_cancelled_impl(&db, "one").unwrap();
        assert_eq!(count(&db, "s1"), 1);
        assert_eq!(event(&db, "s1", None).exdates, vec!["2026-10-27T07:00:00".to_string()]);
        mail(&db, "all", "robin@example.com", &ics("CANCEL", &[vec!["UID:s1".into(), ROBIN.into()]]));
        remove_cancelled_impl(&db, "all").unwrap();
        assert_eq!(count(&db, "s1"), 0);
        assert_eq!(add_published_impl(&db, "all", &cal), Err("calendar.invite.errors.invalid".to_string()));
    }

    #[test]
    fn an_older_cancellation_removes_nothing() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 3, "20261020T070000Z", YES, &[])]), "accepted");
        mail(&db, "c1", "robin@example.com", &ics("CANCEL", &[vevent("r1", 1, "20261020T070000Z", OPEN, &[])]));
        assert_eq!(remove_cancelled_impl(&db, "c1"), Err("calendar.invite.errors.outdated".to_string()));
        assert_eq!(count(&db, "r1"), 1);
    }

    #[test]
    fn answering_a_cancelled_event_is_refused_and_the_card_is_outdated() {
        let (db, cal) = setup();
        let request = ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", YES, &[])]);
        known(&db, &cal, &request, "accepted");
        mail(&db, "orig", "robin@example.com", &request);
        mail(&db, "c0", "robin@example.com", &ics("CANCEL", &[vevent("r1", 0, "20261020T070000Z", OPEN, &[])]));
        assert!(process_mail_impl(&db, "c0").unwrap());
        assert_eq!(event(&db, "r1", None).status, "cancelled");
        assert_eq!(respond_impl(&db, "orig", "accepted", &cal, None, false, now()), Err("calendar.invite.errors.outdated".to_string()));
        assert_eq!(event(&db, "r1", None).status, "cancelled");
        assert!(invitation_view_impl(&db, "orig", now()).unwrap().unwrap().outdated);
    }

    #[test]
    fn unread_mails_from_organizers_of_upcoming_events_are_picked() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", YES, &[])]), "accepted");
        known(&db, &cal, &ics("REQUEST", &[vec!["UID:past".into(), "DTSTART:20250101T070000Z".into(), "ORGANIZER:mailto:old@example.com".into()]]), "accepted");
        {
            let conn = db.lock_db();
            conn.execute("INSERT INTO folders (id, account_id, name, folder_type, path) VALUES ('arch', 'acc', 'Archive', 'archive', 'Archive')", []).unwrap();
            for (id, folder, from, body, date) in [
                ("a", "inbox", "ROBIN@example.com", "", "2026-10-15T10:00:00Z"),
                ("b", "inbox", "robin@example.com", "loaded", "2026-10-15T11:00:00Z"),
                ("c", "arch", "robin@example.com", "", "2026-10-15T12:00:00Z"),
                ("d", "inbox", "old@example.com", "", "2026-10-15T13:00:00Z"),
                ("e", "inbox", "stranger@example.com", "", "2026-10-15T14:00:00Z"),
                ("f", "inbox", "robin@example.com", "", "2026-10-15T15:00:00Z"),
            ] {
                conn.execute(
                    "INSERT INTO mails (id, account_id, folder_id, from_email, body_text, date) VALUES (?1, 'acc', ?2, ?3, ?4, ?5)",
                    params![id, folder, from, body, date],
                )
                .unwrap();
            }
        }
        assert_eq!(relevant_unfetched_mails_impl(&db, "acc", now(), 20).unwrap(), vec!["f".to_string(), "a".to_string()]);
        assert_eq!(relevant_unfetched_mails_impl(&db, "acc", now(), 1).unwrap(), vec!["f".to_string()]);
    }

    #[test]
    fn a_series_update_replaces_the_instances_it_no_longer_carries() {
        let moved = ics(
            "REQUEST",
            &[
                vevent("s1", 0, "20261020T070000Z", YES, &["RRULE:FREQ=WEEKLY;COUNT=4"]),
                vevent("s1", 0, "20261027T090000Z", YES, &["RECURRENCE-ID:20261027T070000Z"]),
            ],
        );
        let shifted = ics("REQUEST", &[vevent("s1", 1, "20261020T080000Z", YES, &["RRULE:FREQ=WEEKLY;COUNT=4"])]);
        for from in ["robin@example.com", "calendar-notification@google.com"] {
            let (db, cal) = setup();
            known(&db, &cal, &moved, "accepted");
            mail(&db, "m2", from, &shifted);
            let applied = process_mail_impl(&db, "m2").unwrap();
            assert_eq!(applied, from.starts_with("robin"), "{from}");
            if !applied {
                respond_impl(&db, "m2", "accepted", &cal, None, false, now()).unwrap();
            }
            let starts: Vec<String> =
                list_occurrences_impl(&db, "2026-10-19T00:00:00Z", "2026-11-16T00:00:00Z", None).unwrap().into_iter().map(|o| o.start).collect();
            assert_eq!(starts, vec!["2026-10-20T08:00:00Z", "2026-10-27T08:00:00Z", "2026-11-03T08:00:00Z", "2026-11-10T08:00:00Z"], "{from}");
        }
    }

    #[test]
    fn changing_my_answer_keeps_my_local_edits() {
        let (db, cal) = setup();
        mail(&db, "m1", "robin@example.com", &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", OPEN, &["DTSTAMP:20261015T080000Z"])]));
        respond_impl(&db, "m1", "accepted", &cal, None, false, now()).unwrap();
        let id = event(&db, "r1", None).id;
        update_event_impl(&db, &id, None, Scope::All, EventPatch { title: Some("My notes".into()), ..Default::default() }).unwrap();
        respond_impl(&db, "m1", "tentative", &cal, None, false, now()).unwrap();
        let row = event(&db, "r1", None);
        assert_eq!((row.title.as_str(), row.my_partstat.as_deref()), ("My notes", Some("tentative")));
    }

    #[test]
    fn reading_the_original_invitation_again_keeps_my_answer() {
        let (db, cal) = setup();
        mail(&db, "m1", "robin@example.com", &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", OPEN, &[])]));
        respond_impl(&db, "m1", "accepted", &cal, None, false, now()).unwrap();
        assert!(!process_mail_impl(&db, "m1").unwrap());
        assert_eq!(event(&db, "r1", None).my_partstat.as_deref(), Some("accepted"));
    }

    #[test]
    fn of_two_updates_with_the_same_sequence_the_later_stamp_wins() {
        let (db, cal) = setup();
        let version = |stamp: &str, room: &str| ics("REQUEST", &[vevent("r1", 1, "20261020T070000Z", YES, &[stamp, room])]);
        known(&db, &cal, &version("DTSTAMP:20261015T080000Z", "LOCATION:Room 1"), "accepted");
        mail(&db, "newer", "robin@example.com", &version("DTSTAMP:20261016T090000Z", "LOCATION:Room 3"));
        mail(&db, "older", "robin@example.com", &version("DTSTAMP:20261016T080000Z", "LOCATION:Room 2"));
        assert!(process_mail_impl(&db, "newer").unwrap());
        assert!(!process_mail_impl(&db, "older").unwrap());
        assert_eq!(event(&db, "r1", None).location, "Room 3");
    }

    #[test]
    fn an_older_instance_update_does_not_revive_a_cancelled_series() {
        let (db, cal) = setup();
        series(&db, &cal);
        mail(&db, "c1", "robin@example.com", &cancel_all(1));
        mail(&db, "old", "robin@example.com", &ics("REQUEST", &[vevent("s1", 0, "20261027T090000Z", YES, &["RECURRENCE-ID:20261027T070000Z"])]));
        assert!(process_mail_impl(&db, "c1").unwrap());
        assert!(!process_mail_impl(&db, "old").unwrap());
        assert_eq!(count(&db, "s1"), 1);
        assert!(invitation_view_impl(&db, "old", now()).unwrap().unwrap().outdated);
        assert_eq!(respond_impl(&db, "old", "accepted", &cal, None, false, now()), Err("calendar.invite.errors.outdated".to_string()));
        assert_eq!(count(&db, "s1"), 1);
    }

    #[test]
    fn a_cancellation_card_is_outdated_only_once_a_newer_invitation_arrives() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", YES, &[])]), "accepted");
        mail(&db, "c0", "robin@example.com", &ics("CANCEL", &[vevent("r1", 0, "20261020T070000Z", OPEN, &[])]));
        assert!(process_mail_impl(&db, "c0").unwrap());
        assert!(!invitation_view_impl(&db, "c0", now()).unwrap().unwrap().outdated);
        mail(&db, "m1", "robin@example.com", &ics("REQUEST", &[vevent("r1", 1, "20261020T080000Z", YES, &[])]));
        assert!(process_mail_impl(&db, "m1").unwrap());
        assert!(invitation_view_impl(&db, "c0", now()).unwrap().unwrap().outdated);
    }

    #[test]
    fn junk_and_trash_wait_for_my_answer() {
        let (db, cal) = setup();
        known(&db, &cal, &ics("REQUEST", &[vevent("r1", 0, "20261020T070000Z", YES, &[])]), "accepted");
        {
            let conn = db.lock_db();
            conn.execute("INSERT INTO folders (id, account_id, name, folder_type, path) VALUES ('junk', 'acc', 'Junk', 'spam', 'Junk')", []).unwrap();
            conn.execute("INSERT INTO folders (id, account_id, name, folder_type, path) VALUES ('bin', 'acc', 'Trash', 'trash', 'Trash')", []).unwrap();
        }
        mail(&db, "j", "robin@example.com", &ics("REQUEST", &[vevent("r1", 1, "20261020T090000Z", YES, &[])]));
        mail(&db, "t", "robin@example.com", &ics("CANCEL", &[vevent("r1", 2, "20261020T090000Z", YES, &[])]));
        db.lock_db().execute("UPDATE mails SET folder_id = CASE id WHEN 'j' THEN 'junk' ELSE 'bin' END WHERE id IN ('j', 't')", []).unwrap();
        assert!(!process_mail_impl(&db, "j").unwrap());
        assert!(!process_mail_impl(&db, "t").unwrap());
        let row = event(&db, "r1", None);
        assert_eq!((row.dtstart.as_str(), row.status.as_str()), ("2026-10-20T07:00:00", "confirmed"));
        assert!(invitation_view_impl(&db, "j", now()).unwrap().unwrap().updated);
        respond_impl(&db, "j", "accepted", &cal, None, false, now()).unwrap();
        assert_eq!(event(&db, "r1", None).dtstart, "2026-10-20T09:00:00");
    }
}
