//! Series expansion. Rules run in the row's own zone so a weekly 09:00 meeting
//! stays at 09:00 across DST; all-day series run on UTC midnights.

use super::tz::{fmt_date, fmt_utc, fmt_wall, parse_date, parse_wall, row_tz, wall_to_utc};
use super::{EventRow, Occurrence};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, Utc};
use chrono_tz::Tz;
use rrule::{Frequency, RRule, RRuleSet, Unvalidated};
use std::collections::HashSet;

pub const MAX_OCCURRENCES: u16 = 5000;
const DAY_CODES: [&str; 7] = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

fn frame_tz(row: &EventRow) -> Tz {
    if row.all_day { Tz::UTC } else { row_tz(row.tzid.as_deref()) }
}

pub fn key_to_naive(all_day: bool, key: &str) -> Option<NaiveDateTime> {
    if all_day { parse_date(key)?.and_hms_opt(0, 0, 0) } else { parse_wall(key) }
}

pub fn naive_to_key(all_day: bool, n: NaiveDateTime) -> String {
    if all_day { fmt_date(n.date()) } else { fmt_wall(n) }
}

pub fn slot_shape(row: &EventRow) -> Option<(NaiveDateTime, Duration)> {
    let start = key_to_naive(row.all_day, &row.dtstart)?;
    let end = key_to_naive(row.all_day, &row.dtend)?;
    Some((start, (end - start).max(Duration::zero())))
}

pub fn is_series(row: &EventRow) -> bool {
    row.recurrence_id.is_none() && (row.rrule.is_some() || !row.rdates.is_empty())
}

/// RFC 5545 wants UNTIL in UTC once DTSTART has a zone; producers often send a
/// date or floating time instead, which the rrule crate rejects.
pub fn normalize_until(rule: &str, all_day: bool, tz: Tz) -> String {
    rule.split(';')
        .map(|part| {
            let Some((k, v)) = part.split_once('=') else { return part.to_string() };
            if !k.trim().eq_ignore_ascii_case("UNTIL") || v.ends_with(['Z', 'z']) {
                return part.to_string();
            }
            let zone = if all_day { Tz::UTC } else { tz };
            let naive = if v.len() == 8 {
                NaiveDate::parse_from_str(v, "%Y%m%d").ok().and_then(|d| d.and_hms_opt(23, 59, 59))
            } else {
                NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok()
            };
            match naive {
                Some(n) => format!("UNTIL={}", wall_to_utc(&zone, n).format("%Y%m%dT%H%M%SZ")),
                None => part.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join(";")
}

fn to_rrule_dt(tz: Tz, n: NaiveDateTime) -> DateTime<rrule::Tz> {
    wall_to_utc(&tz, n).with_timezone(&rrule::Tz::Tz(tz))
}

/// Lists denser than every five minutes stall expansion like sub-hourly frequencies do.
fn too_dense(rule: &str) -> bool {
    rule.split(';').any(|part| {
        let (key, value) = part.split_once('=').unwrap_or((part, ""));
        let count = value.split(',').filter(|v| !v.trim().is_empty()).count();
        (key.eq_ignore_ascii_case("BYSECOND") && count > 1) || (key.eq_ignore_ascii_case("BYMINUTE") && count > 12)
    })
}

/// The row's rule set, or None when it is not a series or its rule is unusable
/// (such rows then behave like single events).
fn rule_set(row: &EventRow) -> Option<RRuleSet> {
    if !is_series(row) {
        return None;
    }
    let tz = frame_tz(row);
    let (start, _) = slot_shape(row)?;
    let dt_start = to_rrule_dt(tz, start);
    let mut set = RRuleSet::new(dt_start);
    let mut has_slots = false;
    if let Some(rule) = &row.rrule {
        let text = normalize_until(rule.trim().trim_start_matches("RRULE:"), row.all_day, tz);
        match text.parse::<RRule<Unvalidated>>() {
            // Expansion walks from DTSTART on every query; minute steps over years stall it.
            Ok(parsed) if matches!(parsed.get_freq(), Frequency::Secondly | Frequency::Minutely) || too_dense(&text) => {
                log::warn!("ignoring sub-hourly RRULE {:?} on event {}", rule, row.id)
            }
            Ok(parsed) => match parsed.validate(dt_start) {
                Ok(valid) => {
                    set = set.rrule(valid);
                    has_slots = true;
                }
                Err(e) => log::warn!("ignoring invalid RRULE {:?} on event {}: {}", rule, row.id, e),
            },
            Err(e) => log::warn!("ignoring unparsable RRULE {:?} on event {}: {}", rule, row.id, e),
        }
    } else {
        // An RDATE-only series still starts at DTSTART.
        set = set.rdate(dt_start);
    }
    for rd in &row.rdates {
        if let Some(n) = key_to_naive(row.all_day, rd) {
            set = set.rdate(to_rrule_dt(tz, n));
            has_slots = true;
        }
    }
    if !has_slots {
        return None;
    }
    for ex in &row.exdates {
        if let Some(n) = key_to_naive(row.all_day, ex) {
            set = set.exdate(to_rrule_dt(tz, n));
        }
    }
    Some(set)
}

pub struct ExpandInput<'a> {
    pub color: &'a str,
    pub has_attendees: bool,
    pub read_only: bool,
    /// Slots of a series that override rows replace.
    pub skip_keys: &'a HashSet<String>,
}

/// Concrete occurrences of one row (series, single event or override) overlapping [from, to).
pub fn expand(row: &EventRow, from: DateTime<Utc>, to: DateTime<Utc>, sys_tz: Tz, input: &ExpandInput) -> Vec<Occurrence> {
    let Some((first, len)) = slot_shape(row) else { return Vec::new() };
    let zone = frame_tz(row);
    let set = rule_set(row);
    let recurring = set.is_some() || row.recurrence_id.is_some();
    let starts: Vec<NaiveDateTime> = match set {
        Some(set) => {
            // Generous window; the overlap test below is exact.
            let rtz = rrule::Tz::Tz(zone);
            let after = (from - len - Duration::days(2)).with_timezone(&rtz);
            let before = (to + Duration::days(2)).with_timezone(&rtz);
            set.after(after).before(before).all(MAX_OCCURRENCES).dates.into_iter().map(|d| d.naive_local()).collect()
        }
        None => vec![first],
    };
    starts
        .into_iter()
        .filter_map(|start| {
            let key = row.recurrence_id.clone().unwrap_or_else(|| naive_to_key(row.all_day, start));
            if row.recurrence_id.is_none() && input.skip_keys.contains(&key) {
                return None;
            }
            let end = start + len;
            let instant_zone = if row.all_day { sys_tz } else { zone };
            let (s, e) = (wall_to_utc(&instant_zone, start), wall_to_utc(&instant_zone, end));
            let overlaps = s < to && (e > from || (e == s && s >= from));
            overlaps.then(|| Occurrence {
                event_id: row.id.clone(),
                calendar_id: row.calendar_id.clone(),
                color: input.color.to_string(),
                title: row.title.clone(),
                location: row.location.clone(),
                description: row.description.clone(),
                all_day: row.all_day,
                start: if row.all_day { fmt_date(start.date()) } else { fmt_utc(s) },
                end: if row.all_day { fmt_date(end.date()) } else { fmt_utc(e) },
                occurrence_key: key,
                is_recurring: recurring,
                is_override: row.recurrence_id.is_some(),
                status: row.status.clone(),
                my_partstat: row.my_partstat.clone(),
                is_organizer: row.is_organizer,
                has_attendees: input.has_attendees,
                read_only: input.read_only,
            })
        })
        .collect()
}

/// `start_utc` / `range_end_utc` column values: first slot's start and last slot's
/// end, None for open-ended series. All-day rows get a 14-hour margin because
/// their instants depend on the viewer's zone.
pub fn derive_range(row: &EventRow) -> Option<(String, Option<String>)> {
    let (first, len) = slot_shape(row)?;
    let tz = frame_tz(row);
    let margin = if row.all_day { Duration::hours(14) } else { Duration::zero() };
    let last_start = match rule_set(row) {
        None => Some(first),
        Some(set) => {
            let rule = row.rrule.as_deref().unwrap_or("").to_ascii_uppercase();
            if row.rrule.is_some() && !rule.contains("COUNT=") && !rule.contains("UNTIL=") {
                None
            } else {
                let result = set.all(MAX_OCCURRENCES);
                if result.limited { None } else { result.dates.last().map(|d| d.naive_local()) }
            }
        }
    };
    let start = fmt_utc(wall_to_utc(&tz, first) - margin);
    let end = last_start.map(|s| fmt_utc(wall_to_utc(&tz, s + len) + margin));
    Some((start, end))
}

fn key_instant(row: &EventRow, key: &str) -> Option<DateTime<Utc>> {
    key_to_naive(row.all_day, key).map(|n| wall_to_utc(&frame_tz(row), n))
}

/// Slots generated before `key`, counting excluded ones as RFC 5545 COUNT does.
pub fn slots_before(row: &EventRow, key: &str) -> usize {
    let bare = EventRow { exdates: vec![], rdates: vec![], ..row.clone() };
    let (Some(set), Some(k)) = (rule_set(&bare), key_to_naive(row.all_day, key)) else { return 0 };
    set.all(MAX_OCCURRENCES).dates.iter().filter(|d| d.naive_local() < k).count()
}

/// The rule with COUNT/UNTIL replaced by an UNTIL just before slot `key`.
pub fn truncate_before(row: &EventRow, key: &str) -> Option<String> {
    let rule = row.rrule.as_deref()?;
    let until = key_instant(row, key)? - Duration::seconds(1);
    let mut parts: Vec<String> = rule
        .split(';')
        .filter(|p| {
            let k = p.split('=').next().unwrap_or("").trim().to_ascii_uppercase();
            k != "COUNT" && k != "UNTIL"
        })
        .map(str::to_string)
        .collect();
    parts.push(format!("UNTIL={}", until.format("%Y%m%dT%H%M%SZ")));
    Some(parts.join(";"))
}

pub fn rule_count(rule: &str) -> Option<usize> {
    rule.split(';').find_map(|p| {
        let (k, v) = p.split_once('=')?;
        if k.trim().eq_ignore_ascii_case("COUNT") { v.trim().parse().ok() } else { None }
    })
}

pub fn with_count(rule: &str, count: usize) -> String {
    rule.split(';')
        .map(|p| {
            let is_count = p.split('=').next().map(|k| k.trim().eq_ignore_ascii_case("COUNT")).unwrap_or(false);
            if is_count { format!("COUNT={}", count) } else { p.to_string() }
        })
        .collect::<Vec<_>>()
        .join(";")
}

fn shift_day_token(tok: &str, days: i64) -> String {
    let tok = tok.trim();
    if tok.len() < 2 {
        return tok.to_string();
    }
    let (prefix, code) = tok.split_at(tok.len() - 2);
    match DAY_CODES.iter().position(|c| c.eq_ignore_ascii_case(code)) {
        Some(i) => format!("{}{}", prefix, DAY_CODES[(i as i64 + days).rem_euclid(7) as usize]),
        None => tok.to_string(),
    }
}

/// Moves weekday and month-day parts along with a series shifted by whole days.
pub fn shift_rrule_days(rule: &str, days: i64) -> String {
    if days == 0 {
        return rule.to_string();
    }
    rule.split(';')
        .map(|part| {
            let Some((k, v)) = part.split_once('=') else { return part.to_string() };
            match k.trim().to_ascii_uppercase().as_str() {
                "BYDAY" => format!("{}={}", k, v.split(',').map(|t| shift_day_token(t, days)).collect::<Vec<_>>().join(",")),
                "BYMONTHDAY" => format!(
                    "{}={}",
                    k,
                    v.split(',')
                        .map(|t| match t.trim().parse::<i64>() {
                            Ok(n) if n > 0 => ((n - 1 + days).rem_euclid(31) + 1).to_string(),
                            _ => t.to_string(),
                        })
                        .collect::<Vec<_>>()
                        .join(",")
                ),
                _ => part.to_string(),
            }
        })
        .collect::<Vec<_>>()
        .join(";")
}

/// Moves an UNTIL bound along with a shifted series; unparsable values stay as they are.
pub fn shift_until(rule: &str, _all_day: bool, delta: Duration) -> String {
    rule.split(';')
        .map(|part| {
            let Some((k, v)) = part.split_once('=') else { return part.to_string() };
            if !k.trim().eq_ignore_ascii_case("UNTIL") {
                return part.to_string();
            }
            let shifted = if let Some(raw) = v.strip_suffix('Z') {
                NaiveDateTime::parse_from_str(raw, "%Y%m%dT%H%M%S").ok().map(|n| format!("{}Z", (n + delta).format("%Y%m%dT%H%M%S")))
            } else if let Ok(d) = NaiveDate::parse_from_str(v, "%Y%m%d") {
                Some((d + Duration::days(delta.num_days())).format("%Y%m%d").to_string())
            } else {
                NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok().map(|n| (n + delta).format("%Y%m%dT%H%M%S").to_string())
            };
            format!("{}={}", k, shifted.unwrap_or_else(|| v.to_string()))
        })
        .collect::<Vec<_>>()
        .join(";")
}

fn is_until(part: &str) -> bool {
    part.split('=').next().is_some_and(|k| k.trim().eq_ignore_ascii_case("UNTIL"))
}

/// `rule` with UNTIL at the end of the day of `old`'s last slot (moved by `days`)
/// in `new`'s frame, for a series switched between timed and all-day.
pub fn rebound_until(rule: &str, old: &EventRow, new: &EventRow, days: i64) -> String {
    let bare = EventRow { exdates: vec![], rdates: vec![], ..old.clone() };
    let Some(set) = rule.split(';').any(is_until).then(|| rule_set(&bare)).flatten() else { return rule.to_string() };
    let result = set.all(MAX_OCCURRENCES);
    let (false, Some(last)) = (result.limited, result.dates.last()) else { return rule.to_string() };
    let day_end = (last.naive_local().date() + Duration::days(days)).and_hms_opt(23, 59, 59).expect("23:59:59 is valid");
    let until = wall_to_utc(&frame_tz(new), day_end).format("%Y%m%dT%H%M%SZ");
    rule.split(';')
        .map(|p| if is_until(p) { format!("UNTIL={}", until) } else { p.to_string() })
        .collect::<Vec<_>>()
        .join(";")
}

pub fn shift_key(all_day: bool, key: &str, by: Duration) -> String {
    match key_to_naive(all_day, key) {
        Some(n) => naive_to_key(all_day, n + by),
        None => key.to_string(),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::tz::parse_utc;

    fn row(dtstart: &str, dtend: &str, tzid: Option<&str>, rrule: Option<&str>) -> EventRow {
        EventRow {
            id: "e".into(),
            calendar_id: "c".into(),
            uid: "u".into(),
            recurrence_id: None,
            title: "T".into(),
            description: String::new(),
            location: String::new(),
            all_day: dtstart.len() == 10,
            dtstart: dtstart.into(),
            dtend: dtend.into(),
            tzid: tzid.map(str::to_string),
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
        }
    }

    fn run_skipping(r: &EventRow, from: &str, to: &str, skip: &HashSet<String>) -> Vec<Occurrence> {
        let input = ExpandInput { color: "#000000", has_attendees: false, read_only: false, skip_keys: skip };
        expand(r, parse_utc(from).unwrap(), parse_utc(to).unwrap(), chrono_tz::Europe::Berlin, &input)
    }

    fn starts(r: &EventRow, from: &str, to: &str) -> Vec<String> {
        run_skipping(r, from, to, &HashSet::new()).into_iter().map(|o| o.start).collect()
    }

    const BERLIN: Option<&str> = Some("Europe/Berlin");

    #[test]
    fn weekly_series_keeps_wall_clock_across_dst() {
        let r = row("2026-10-05T09:00:00", "2026-10-05T09:30:00", BERLIN, Some("FREQ=WEEKLY;BYDAY=MO"));
        assert_eq!(starts(&r, "2026-10-18T00:00:00Z", "2026-11-01T00:00:00Z"), vec!["2026-10-19T07:00:00Z", "2026-10-26T08:00:00Z"]);
        let occ = run_skipping(&r, "2026-10-18T00:00:00Z", "2026-10-20T00:00:00Z", &HashSet::new());
        assert_eq!(occ[0].occurrence_key, "2026-10-19T09:00:00");
        assert_eq!(occ[0].end, "2026-10-19T07:30:00Z");
        assert!(occ[0].is_recurring && !occ[0].is_override);
    }

    #[test]
    fn exdates_and_override_keys_remove_slots() {
        let mut r = row("2026-10-05T09:00:00", "2026-10-05T09:30:00", BERLIN, Some("FREQ=WEEKLY;BYDAY=MO"));
        r.exdates = vec!["2026-10-19T09:00:00".into()];
        let skip: HashSet<String> = ["2026-10-26T09:00:00".to_string()].into_iter().collect();
        let got: Vec<String> = run_skipping(&r, "2026-10-18T00:00:00Z", "2026-11-03T00:00:00Z", &skip).into_iter().map(|o| o.start).collect();
        assert_eq!(got, vec!["2026-11-02T08:00:00Z"]);
    }

    #[test]
    fn override_rows_report_their_original_slot() {
        let mut r = row("2026-10-26T11:00:00", "2026-10-26T11:30:00", BERLIN, None);
        r.recurrence_id = Some("2026-10-26T09:00:00".into());
        let occ = run_skipping(&r, "2026-10-26T00:00:00Z", "2026-10-27T00:00:00Z", &HashSet::new());
        assert_eq!(occ.len(), 1);
        assert_eq!(occ[0].occurrence_key, "2026-10-26T09:00:00");
        assert_eq!(occ[0].start, "2026-10-26T10:00:00Z");
        assert!(occ[0].is_override && occ[0].is_recurring);
    }

    #[test]
    fn count_limits_the_series_and_its_range() {
        let r = row("2026-10-15T09:00:00", "2026-10-15T09:30:00", BERLIN, Some("FREQ=DAILY;COUNT=3"));
        assert_eq!(starts(&r, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z").len(), 3);
        assert_eq!(derive_range(&r), Some(("2026-10-15T07:00:00Z".to_string(), Some("2026-10-17T07:30:00Z".to_string()))));
    }

    #[test]
    fn date_only_until_includes_the_last_day() {
        assert_eq!(normalize_until("FREQ=DAILY;UNTIL=20261017", false, chrono_tz::Europe::Berlin), "FREQ=DAILY;UNTIL=20261017T215959Z");
        assert_eq!(normalize_until("FREQ=DAILY;UNTIL=20261017T235959Z", false, chrono_tz::Europe::Berlin), "FREQ=DAILY;UNTIL=20261017T235959Z");
        let r = row("2026-10-15T09:00:00", "2026-10-15T10:00:00", BERLIN, Some("FREQ=DAILY;UNTIL=20261017"));
        assert_eq!(starts(&r, "2026-10-14T00:00:00Z", "2026-10-21T00:00:00Z").len(), 3);
    }

    #[test]
    fn day_31_skips_short_months() {
        let r = row("2026-01-31T10:00:00", "2026-01-31T11:00:00", BERLIN, Some("FREQ=MONTHLY;BYMONTHDAY=31"));
        assert_eq!(
            starts(&r, "2026-01-01T00:00:00Z", "2026-07-01T00:00:00Z"),
            vec!["2026-01-31T09:00:00Z", "2026-03-31T08:00:00Z", "2026-05-31T08:00:00Z"]
        );
    }

    #[test]
    fn third_thursday_of_the_month() {
        let r = row("2026-10-15T18:00:00", "2026-10-15T19:00:00", BERLIN, Some("FREQ=MONTHLY;BYDAY=3TH"));
        assert_eq!(starts(&r, "2026-10-01T00:00:00Z", "2026-12-01T00:00:00Z"), vec!["2026-10-15T16:00:00Z", "2026-11-19T17:00:00Z"]);
    }

    #[test]
    fn all_day_events_return_dates_and_widen_their_range() {
        let r = row("2026-12-24", "2026-12-27", None, None);
        let occ = run_skipping(&r, "2026-12-25T00:00:00Z", "2026-12-26T00:00:00Z", &HashSet::new());
        assert_eq!((occ[0].start.as_str(), occ[0].end.as_str()), ("2026-12-24", "2026-12-27"));
        assert!(starts(&r, "2026-12-28T00:00:00Z", "2026-12-29T00:00:00Z").is_empty());
        assert_eq!(derive_range(&r), Some(("2026-12-23T10:00:00Z".to_string(), Some("2026-12-27T14:00:00Z".to_string()))));
    }

    #[test]
    fn open_ended_series_reach_the_far_future() {
        let r = row("2026-10-15T09:00:00", "2026-10-15T09:15:00", BERLIN, Some("FREQ=DAILY"));
        assert_eq!(starts(&r, "2031-03-02T00:00:00Z", "2031-03-09T00:00:00Z").len(), 7);
        assert_eq!(derive_range(&r).unwrap().1, None);
    }

    #[test]
    fn invalid_rules_fall_back_to_a_single_event() {
        let r = row("2026-10-15T09:00:00", "2026-10-15T10:00:00", BERLIN, Some("FREQ=SOMETIMES"));
        assert_eq!(starts(&r, "2026-10-01T00:00:00Z", "2026-11-01T00:00:00Z"), vec!["2026-10-15T07:00:00Z"]);
        assert!(derive_range(&r).unwrap().1.is_some());
    }

    #[test]
    fn minutely_and_secondly_rules_fall_back_to_a_single_event() {
        let r = row("2020-01-06T09:00:00", "2020-01-06T09:30:00", BERLIN, Some("FREQ=MINUTELY"));
        assert_eq!(starts(&r, "2020-01-06T00:00:00Z", "2020-01-07T00:00:00Z"), vec!["2020-01-06T08:00:00Z"]);
        assert!(derive_range(&r).unwrap().1.is_some());
        let s = row("2020-01-06T09:00:00", "2020-01-06T09:30:00", BERLIN, Some("FREQ=SECONDLY;COUNT=5"));
        assert_eq!(starts(&s, "2020-01-06T00:00:00Z", "2020-01-07T00:00:00Z").len(), 1);
        let h = row("2026-10-15T09:00:00", "2026-10-15T09:15:00", BERLIN, Some("FREQ=HOURLY;COUNT=3"));
        assert_eq!(starts(&h, "2026-10-15T00:00:00Z", "2026-10-16T00:00:00Z").len(), 3);
    }

    #[test]
    fn shifts_weekday_and_month_day_parts() {
        assert_eq!(shift_rrule_days("FREQ=WEEKLY;BYDAY=MO,WE", 1), "FREQ=WEEKLY;BYDAY=TU,TH");
        assert_eq!(shift_rrule_days("FREQ=MONTHLY;BYDAY=3TH", 1), "FREQ=MONTHLY;BYDAY=3FR");
        assert_eq!(shift_rrule_days("FREQ=WEEKLY;BYDAY=SA", 1), "FREQ=WEEKLY;BYDAY=SU");
        assert_eq!(shift_rrule_days("FREQ=MONTHLY;BYMONTHDAY=15", -1), "FREQ=MONTHLY;BYMONTHDAY=14");
        assert_eq!(shift_rrule_days("FREQ=DAILY", 3), "FREQ=DAILY");
        assert_eq!(shift_key(false, "2026-10-12T09:00:00", Duration::days(1)), "2026-10-13T09:00:00");
        assert_eq!(shift_key(true, "2026-10-12", Duration::days(-2)), "2026-10-10");
    }

    #[test]
    fn split_helpers_count_raw_slots_and_cut_before_a_key() {
        let mut r = row("2026-10-05T09:00:00", "2026-10-05T09:30:00", BERLIN, Some("FREQ=WEEKLY;BYDAY=MO;COUNT=5"));
        r.exdates = vec!["2026-10-12T09:00:00".into()];
        assert_eq!(slots_before(&r, "2026-10-19T09:00:00"), 2, "COUNT counts excluded slots too");
        assert_eq!(truncate_before(&r, "2026-10-19T09:00:00").as_deref(), Some("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T065959Z"));
        assert_eq!(rule_count("FREQ=WEEKLY;COUNT=5"), Some(5));
        assert_eq!(rule_count("FREQ=WEEKLY"), None);
        assert_eq!(with_count("FREQ=WEEKLY;COUNT=5;BYDAY=MO", 3), "FREQ=WEEKLY;COUNT=3;BYDAY=MO");
    }

    #[test]
    fn until_keeps_the_last_day_across_a_form_switch() {
        let old = row("2026-10-05T09:00:00", "2026-10-05T09:30:00", BERLIN, Some("FREQ=WEEKLY;BYDAY=MO;UNTIL=20261019T065959Z"));
        let new = row("2026-10-05", "2026-10-06", None, None);
        assert_eq!(rebound_until(old.rrule.as_deref().unwrap(), &old, &new, 0), "FREQ=WEEKLY;BYDAY=MO;UNTIL=20261012T235959Z");
        assert_eq!(rebound_until("FREQ=WEEKLY;BYDAY=TU", &old, &new, 1), "FREQ=WEEKLY;BYDAY=TU");
    }

    #[test]
    fn until_shifts_with_the_series() {
        let d = Duration::days(1);
        assert_eq!(shift_until("FREQ=WEEKLY;UNTIL=20261026T235959Z;BYDAY=MO", false, d), "FREQ=WEEKLY;UNTIL=20261027T235959Z;BYDAY=MO");
        assert_eq!(shift_until("FREQ=DAILY;UNTIL=20261026", true, d), "FREQ=DAILY;UNTIL=20261027");
        assert_eq!(shift_until("FREQ=DAILY;UNTIL=junk", true, d), "FREQ=DAILY;UNTIL=junk");
        assert_eq!(shift_until("FREQ=DAILY;COUNT=3", false, d), "FREQ=DAILY;COUNT=3");
    }

    #[test]
    fn dense_minute_and_second_lists_fall_back_to_a_single_event() {
        let minutes = (0..13).map(|m| (m * 4).to_string()).collect::<Vec<_>>().join(",");
        let dense_rule = format!("FREQ=DAILY;BYHOUR=9;BYMINUTE={}", minutes);
        let dense = row("2026-10-05T09:00:00", "2026-10-05T09:01:00", BERLIN, Some(dense_rule.as_str()));
        assert_eq!(starts(&dense, "2026-10-05T00:00:00Z", "2026-10-08T00:00:00Z"), vec!["2026-10-05T07:00:00Z"]);
        let seconds = row("2026-10-05T09:00:00", "2026-10-05T09:01:00", BERLIN, Some("FREQ=DAILY;BYSECOND=0,30"));
        assert_eq!(starts(&seconds, "2026-10-05T00:00:00Z", "2026-10-08T00:00:00Z").len(), 1);
        let fine = row("2026-10-05T09:00:00", "2026-10-05T09:15:00", BERLIN, Some("FREQ=DAILY;COUNT=2;BYHOUR=9;BYMINUTE=0,30"));
        assert_eq!(starts(&fine, "2026-10-05T00:00:00Z", "2026-10-08T00:00:00Z"), vec!["2026-10-05T07:00:00Z", "2026-10-05T07:30:00Z"]);
    }
}
