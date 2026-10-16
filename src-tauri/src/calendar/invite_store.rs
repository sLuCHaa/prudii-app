//! Invitations stored on mails: organizer updates applied on arrival, the card's
//! view and the user's answers. Pure iTIP lives in `itip.rs`.

use super::ical::{parse_calendar, ParsedEvent};
use super::invite_mail::FoundInvite;
use super::itip::{self, CancelTarget, Me};
use super::recurrence::{derive_range, key_to_naive, naive_to_key, slot_shape};
use super::store::{load_alarms, row_to_event, set_alarms, set_attendees, write_event, EVENT_COLS};
use super::{Attendee, EventRow, SUBSCRIPTION};
use crate::db::Database;
use rusqlite::{params, Connection, OptionalExtension};

fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}

struct MailInvite {
    account_email: String,
    from_email: String,
    method: Option<String>,
    ics: Option<String>,
}

fn load_mail(conn: &Connection, mail_id: &str) -> Result<MailInvite, String> {
    conn.query_row(
        "SELECT a.email, m.from_email, m.invite_method, m.invite_ics
         FROM mails m JOIN accounts a ON a.id = m.account_id WHERE m.id = ?1",
        params![mail_id],
        |r| Ok(MailInvite { account_email: r.get(0)?, from_email: r.get(1)?, method: r.get(2)?, ics: r.get(3)? }),
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
    if master.recurrence_id.is_some() || p.recurrence_id.is_none() {
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

fn auto_update(conn: &Connection, mail: &MailInvite, p: &ParsedEvent) -> Result<bool, String> {
    if same(p.organizer_email.as_deref(), &mail.account_email) {
        return Ok(false);
    }
    let rows = known_rows(conn, &p.uid)?;
    let Some(anchor) = rows.first() else { return Ok(false) };
    if !same(anchor.organizer_email.as_deref(), &mail.from_email) {
        return Ok(false);
    }
    let me = itip::find_me(p, &mail.account_email);
    match rows.iter().find(|r| r.recurrence_id == p.recurrence_id) {
        Some(slot) if p.sequence >= slot.sequence => apply_update(conn, slot, p, &me),
        Some(_) => Ok(false),
        None => add_override(conn, anchor, p, &me),
    }
}

fn cancel_slot(conn: &Connection, master: &EventRow, key: &str) -> Result<bool, String> {
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
            Some(k) if anchor.recurrence_id.is_none() && target.sequence >= anchor.sequence => cancel_slot(conn, anchor, k),
            _ => Ok(false),
        };
    }
    let mut changed = false;
    for r in hit.into_iter().filter(|r| r.status != "cancelled" && target.sequence >= r.sequence) {
        let mut row = r.clone();
        row.status = "cancelled".into();
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
    let tx = conn.unchecked_transaction().map_err(err)?;
    let mut changed = false;
    if method == "REQUEST" {
        for p in &parse_calendar(ics).events {
            changed |= auto_update(&tx, &mail, p)?;
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
    match process_mail_impl(db, mail_id) {
        Ok(true) => super::notify_changed(),
        Ok(false) => {}
        Err(e) => log::warn!("invitation of {} not applied: {}", mail_id, e),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::content_line::fold_line;
    use crate::calendar::ical::parse_calendar;
    use crate::calendar::store::{import_ics_impl, list_calendars_impl, load_alarms, mirror_ics_impl, update_event_impl};
    use crate::calendar::{EventPatch, FeedMeta, Scope};

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
}
