//! Event reminders, ticked from the same 60-second loop as task reminders.

use crate::calendar::store::{mark_reminder_sent_impl, prune_reminders_impl, reminder_candidates_impl, sent_reminders_impl, SentKey};
use crate::calendar::tz::{parse_date, parse_utc, system_tz, wall_to_utc};
use crate::calendar::Occurrence;
use crate::db::Database;
use crate::notifications;
use chrono::{DateTime, Duration, Utc};
use chrono_tz::Tz;
use std::collections::HashSet;
use tauri::{AppHandle, Manager};

// Same storm guard as task reminders: the rest follow on the next ticks.
const MAX_REMINDERS_PER_TICK: usize = 5;
const ALL_DAY_REMINDER_HOUR: u32 = 9;

#[derive(Debug, Clone, PartialEq)]
pub struct DueReminder {
    pub occurrence: Occurrence,
    pub minutes_before: i64,
}

/// The instant a reminder counts back from (09:00 local for all-day events) and the slot's end.
fn anchor_and_end(o: &Occurrence, sys: Tz) -> Option<(DateTime<Utc>, DateTime<Utc>)> {
    if o.all_day {
        let anchor = parse_date(&o.start)?.and_hms_opt(ALL_DAY_REMINDER_HOUR, 0, 0)?;
        let end = parse_date(&o.end)?.and_hms_opt(0, 0, 0)?;
        Some((wall_to_utc(&sys, anchor), wall_to_utc(&sys, end)))
    } else {
        Some((parse_utc(&o.start)?, parse_utc(&o.end)?))
    }
}

/// Reminders whose trigger has passed while the slot is not over yet, oldest trigger first.
pub fn select_due(candidates: &[(Occurrence, Vec<i64>)], sent: &HashSet<SentKey>, now: DateTime<Utc>, sys: Tz) -> Vec<DueReminder> {
    let mut due: Vec<(DateTime<Utc>, DueReminder)> = Vec::new();
    for (occ, alarms) in candidates {
        if occ.status == "cancelled" || occ.my_partstat.as_deref() == Some("declined") {
            continue;
        }
        let Some((anchor, end)) = anchor_and_end(occ, sys) else { continue };
        let end = end.max(anchor + Duration::minutes(1));
        for minutes in alarms {
            let trigger = anchor - Duration::minutes(*minutes);
            let key = (occ.event_id.clone(), occ.start.clone(), *minutes);
            if trigger <= now && end > now && !sent.contains(&key) {
                due.push((trigger, DueReminder { occurrence: occ.clone(), minutes_before: *minutes }));
            }
        }
    }
    due.sort_by_key(|(trigger, _)| *trigger);
    due.into_iter().take(MAX_REMINDERS_PER_TICK).map(|(_, d)| d).collect()
}

pub async fn run_event_reminder_check(app: &AppHandle) {
    let now = Utc::now();
    let db = app.state::<Database>();
    let candidates = match reminder_candidates_impl(&db, now) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("event reminder check failed: {}", e);
            return;
        }
    };
    let sent = sent_reminders_impl(&db).unwrap_or_default();
    for due in select_due(&candidates, &sent, now, system_tz()) {
        // Recorded before sending: a failing toast must not retry every minute.
        let key = (due.occurrence.event_id.clone(), due.occurrence.start.clone(), due.minutes_before);
        match mark_reminder_sent_impl(&db, &key) {
            Ok(true) => notifications::send_event_reminder(app, &due.occurrence),
            Ok(false) => {}
            Err(e) => log::warn!("failed to record reminder for event {}: {}", key.0, e),
        }
    }
    if let Err(e) = prune_reminders_impl(&db) {
        log::warn!("failed to prune the reminder log: {}", e);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::tz::parse_utc;

    fn occ(id: &str, start: &str, end: &str) -> Occurrence {
        Occurrence {
            event_id: id.into(),
            calendar_id: "c".into(),
            color: "#000000".into(),
            title: id.into(),
            location: String::new(),
            description: String::new(),
            all_day: start.len() == 10,
            start: start.into(),
            end: end.into(),
            occurrence_key: start.into(),
            is_recurring: false,
            is_override: false,
            status: "confirmed".into(),
            my_partstat: None,
            is_organizer: false,
            has_attendees: false,
        }
    }

    fn due_at(cands: &[(Occurrence, Vec<i64>)], sent: &HashSet<SentKey>, now: &str) -> Vec<(String, i64)> {
        select_due(cands, sent, parse_utc(now).unwrap(), chrono_tz::Europe::Berlin)
            .into_iter()
            .map(|d| (d.occurrence.event_id, d.minutes_before))
            .collect()
    }

    #[test]
    fn fires_once_the_trigger_has_passed() {
        let cands = vec![(occ("a", "2026-10-15T10:00:00Z", "2026-10-15T11:00:00Z"), vec![15])];
        let none = HashSet::new();
        assert!(due_at(&cands, &none, "2026-10-15T09:44:59Z").is_empty());
        assert_eq!(due_at(&cands, &none, "2026-10-15T09:45:00Z"), vec![("a".to_string(), 15)]);
        let sent: HashSet<SentKey> = [("a".to_string(), "2026-10-15T10:00:00Z".to_string(), 15)].into_iter().collect();
        assert!(due_at(&cands, &sent, "2026-10-15T09:46:00Z").is_empty());
    }

    #[test]
    fn still_fires_for_a_running_event_after_a_restart_but_not_after_its_end() {
        let cands = vec![(occ("a", "2026-10-15T10:00:00Z", "2026-10-15T11:00:00Z"), vec![15])];
        assert_eq!(due_at(&cands, &HashSet::new(), "2026-10-15T10:10:00Z").len(), 1);
        assert!(due_at(&cands, &HashSet::new(), "2026-10-15T11:00:00Z").is_empty());
    }

    #[test]
    fn all_day_events_anchor_at_nine_local() {
        let cands = vec![(occ("h", "2026-10-15", "2026-10-16"), vec![0, 1440])];
        assert_eq!(due_at(&cands, &HashSet::new(), "2026-10-14T06:59:00Z"), vec![]);
        assert_eq!(due_at(&cands, &HashSet::new(), "2026-10-14T07:00:00Z"), vec![("h".to_string(), 1440)]);
        assert_eq!(due_at(&cands, &HashSet::new(), "2026-10-15T07:00:00Z"), vec![("h".to_string(), 1440), ("h".to_string(), 0)]);
    }

    #[test]
    fn skips_cancelled_and_declined_slots() {
        let mut cancelled = occ("c", "2026-10-15T10:00:00Z", "2026-10-15T11:00:00Z");
        cancelled.status = "cancelled".into();
        let mut declined = occ("d", "2026-10-15T10:00:00Z", "2026-10-15T11:00:00Z");
        declined.my_partstat = Some("declined".into());
        let cands = vec![(cancelled, vec![0]), (declined, vec![0])];
        assert!(due_at(&cands, &HashSet::new(), "2026-10-15T10:05:00Z").is_empty());
    }

    #[test]
    fn caps_each_tick_and_orders_by_trigger() {
        let cands: Vec<(Occurrence, Vec<i64>)> = (0..8)
            .map(|i| (occ(&format!("e{i}"), &format!("2026-10-15T10:{:02}:00Z", 50 - i * 5), "2026-10-15T12:00:00Z"), vec![0]))
            .collect();
        let got = due_at(&cands, &HashSet::new(), "2026-10-15T11:00:00Z");
        assert_eq!(got.len(), MAX_REMINDERS_PER_TICK);
        assert_eq!(got[0].0, "e7");
    }
}
