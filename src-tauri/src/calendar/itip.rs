//! iTIP without the database: who "I" am in an invitation, which event a mail is
//! about, what a CANCEL names, and the REPLY sent back.

use super::content_line::{escape_text, fold_line, parse_components, write_prop, Component};
use super::ical::{parse_calendar, ParsedCalendar, ParsedEvent};
use chrono::{DateTime, Utc};

#[derive(Debug, Clone, PartialEq)]
pub struct Me {
    /// The address as the organizer listed it, else the account address.
    pub email: String,
    /// The organizer's record of my answer, lower-case; None when I am not listed.
    pub partstat: Option<String>,
    /// False only for an explicit RSVP=FALSE.
    pub rsvp: bool,
    /// My ATTENDEE parameters except PARTSTAT and RSVP, kept for the reply.
    pub params: Vec<(String, String)>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CancelTarget {
    pub uid: String,
    pub recurrence_id: Option<String>,
    pub sequence: i64,
}

fn address(value: &str) -> String {
    let v = value.trim();
    match v.get(..7) {
        Some(prefix) if prefix.eq_ignore_ascii_case("mailto:") => v[7..].trim().to_string(),
        _ => v.to_string(),
    }
}

fn vevent(p: &ParsedEvent) -> Component {
    parse_components(&p.raw).into_iter().find(|c| c.name == "VEVENT").unwrap_or_default()
}

pub fn find_me(p: &ParsedEvent, account_email: &str) -> Me {
    let wanted = account_email.trim();
    let event = vevent(p);
    let mine = event.props_named("ATTENDEE").find(|a| address(&a.value).eq_ignore_ascii_case(wanted));
    match mine {
        Some(a) => Me {
            email: address(&a.value),
            partstat: Some(a.param("PARTSTAT").unwrap_or("NEEDS-ACTION").to_ascii_lowercase()),
            rsvp: !a.param("RSVP").is_some_and(|v| v.eq_ignore_ascii_case("FALSE")),
            params: a.params.iter().filter(|(k, _)| k != "PARTSTAT" && k != "RSVP").cloned().collect(),
        },
        None => Me { email: wanted.to_string(), partstat: None, rsvp: true, params: Vec::new() },
    }
}

/// The event a mail is about: its series if present, else the first instance.
pub fn primary_event(cal: &ParsedCalendar) -> Option<&ParsedEvent> {
    cal.events.iter().find(|e| e.recurrence_id.is_none()).or_else(|| cal.events.first())
}

/// RFC 5546 lets a CANCEL omit DTSTART, which the event parser needs; such
/// events still cancel by UID.
pub fn cancel_targets(ics: &str) -> Vec<CancelTarget> {
    let mut out: Vec<CancelTarget> = parse_calendar(ics)
        .events
        .iter()
        .map(|p| CancelTarget { uid: p.uid.clone(), recurrence_id: p.recurrence_id.clone(), sequence: p.sequence })
        .collect();
    for root in parse_components(ics.strip_prefix('\u{feff}').unwrap_or(ics)) {
        let events = if root.name == "VCALENDAR" { root.children } else { vec![root] };
        for c in events.into_iter().filter(|c| c.name == "VEVENT" && c.prop("DTSTART").is_none() && c.prop("RECURRENCE-ID").is_none()) {
            if let Some(uid) = c.text("UID").map(|u| u.trim().to_string()).filter(|u| !u.is_empty()) {
                let sequence = c.prop("SEQUENCE").and_then(|p| p.value.trim().parse().ok()).unwrap_or(0);
                out.push(CancelTarget { uid, recurrence_id: None, sequence });
            }
        }
    }
    out
}

fn borrowed(params: &[(String, String)]) -> Vec<(&str, &str)> {
    params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
}

fn copy(event: &Component, name: &str) -> String {
    event.prop(name).map(|p| write_prop(name, &borrowed(&p.params), &p.value)).unwrap_or_default()
}

const COPIED: [&str; 6] = ["RECURRENCE-ID", "DTSTART", "DTEND", "DURATION", "SUMMARY", "ORGANIZER"];

fn timezones(ics: &str) -> Vec<Component> {
    parse_components(ics.strip_prefix('\u{feff}').unwrap_or(ics))
        .into_iter()
        .filter(|c| c.name == "VCALENDAR")
        .flat_map(|c| c.children)
        .filter(|c| c.name == "VTIMEZONE")
        .collect()
}

/// iMIP REPLY: the organizer's identifiers and times verbatim (with the zones
/// they name) and only my ATTENDEE with the new answer.
pub fn build_reply(ics: &str, event: &ParsedEvent, me: &Me, partstat: &str, comment: Option<&str>, dtstamp: DateTime<Utc>) -> String {
    let src = vevent(event);
    let mut body = String::from("BEGIN:VEVENT\r\n");
    body += &if src.prop("UID").is_some() { copy(&src, "UID") } else { write_prop("UID", &[], &escape_text(&event.uid)) };
    body += &write_prop("DTSTAMP", &[], &dtstamp.format("%Y%m%dT%H%M%SZ").to_string());
    body += &write_prop("SEQUENCE", &[], &event.sequence.to_string());
    for name in COPIED {
        body += &copy(&src, name);
    }
    let mut params = me.params.clone();
    params.push(("PARTSTAT".into(), partstat.to_ascii_uppercase()));
    body += &write_prop("ATTENDEE", &borrowed(&params), &format!("mailto:{}", me.email));
    if let Some(c) = comment.map(str::trim).filter(|c| !c.is_empty()) {
        body += &write_prop("COMMENT", &[], &escape_text(c));
    }
    body += "END:VEVENT\r\n";

    let zones: Vec<String> = COPIED.iter().filter_map(|n| src.prop(n)?.param("TZID").map(|z| z.trim().to_string())).collect();
    let mut out = String::from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Prudii//Prudii Mail//EN\r\nCALSCALE:GREGORIAN\r\nMETHOD:REPLY\r\n");
    for tz in timezones(ics) {
        if tz.prop("TZID").is_some_and(|p| zones.iter().any(|z| z == p.value.trim())) {
            for line in tz.raw.split("\r\n").filter(|l| !l.is_empty()) {
                out += &fold_line(line);
            }
        }
    }
    out += &body;
    out += "END:VCALENDAR\r\n";
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::ical::parse_calendar;
    use chrono::TimeZone;

    const GOOGLE: &str = include_str!("fixtures/google_weekly.ics");
    const SERIES_AND_INSTANCE: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nRECURRENCE-ID:20261027T070000Z\r\nDTSTART:20261027T090000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261020T070000Z\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
    const ONLY_INSTANCE: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nRECURRENCE-ID:20261027T070000Z\r\nDTSTART:20261027T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    fn stamp() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 10, 16, 8, 0, 0).unwrap()
    }

    #[test]
    fn finds_me_case_insensitively_with_my_listed_parameters() {
        let cal = parse_calendar(GOOGLE);
        let me = find_me(&cal.events[0], "SAM@example.com");
        assert_eq!(me.email, "sam@example.com");
        assert_eq!(me.partstat.as_deref(), Some("needs-action"));
        assert!(me.rsvp);
        assert!(me.params.iter().any(|(k, v)| k == "CN" && v == "Sam Example"));
        assert!(!me.params.iter().any(|(k, _)| k == "PARTSTAT" || k == "RSVP"));
    }

    #[test]
    fn an_unlisted_account_answers_with_its_own_address() {
        let cal = parse_calendar(GOOGLE);
        assert_eq!(
            find_me(&cal.events[0], "other@example.com"),
            Me { email: "other@example.com".into(), partstat: None, rsvp: true, params: vec![] }
        );
    }

    #[test]
    fn only_an_explicit_rsvp_false_turns_the_reply_off() {
        let text = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a\r\nDTSTART:20261020T070000Z\r\nATTENDEE;RSVP=FALSE:mailto:sam@example.com\r\nATTENDEE:MAILTO:kim@example.com\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let cal = parse_calendar(text);
        assert!(!find_me(&cal.events[0], "sam@example.com").rsvp);
        let kim = find_me(&cal.events[0], "kim@example.com");
        assert!(kim.rsvp);
        assert_eq!(kim.partstat.as_deref(), Some("needs-action"));
    }

    #[test]
    fn the_series_is_the_primary_event() {
        assert_eq!(primary_event(&parse_calendar(SERIES_AND_INSTANCE)).unwrap().recurrence_id, None);
        assert_eq!(
            primary_event(&parse_calendar(ONLY_INSTANCE)).unwrap().recurrence_id.as_deref(),
            Some("2026-10-27T07:00:00")
        );
    }

    #[test]
    fn cancellations_name_their_events_even_without_a_start() {
        let text = "BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nBEGIN:VEVENT\r\nUID:a\r\nSEQUENCE:2\r\nRECURRENCE-ID:20261027T070000Z\r\nDTSTART:20261027T070000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nSEQUENCE:4\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:c\r\nRECURRENCE-ID:20261027T070000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        assert_eq!(
            cancel_targets(text),
            vec![
                CancelTarget { uid: "a".into(), recurrence_id: Some("2026-10-27T07:00:00".into()), sequence: 2 },
                CancelTarget { uid: "b".into(), recurrence_id: None, sequence: 4 },
            ]
        );
    }

    #[test]
    fn a_reply_names_only_me_with_the_new_answer() {
        let cal = parse_calendar(GOOGLE);
        let me = find_me(&cal.events[0], "sam@example.com");
        let reply = build_reply(GOOGLE, &cal.events[0], &me, "accepted", Some("Running late, see you there"), stamp());
        let flat = reply.replace("\r\n ", "");
        assert!(flat.starts_with("BEGIN:VCALENDAR\r\n"));
        assert!(flat.contains("METHOD:REPLY\r\n"));
        assert_eq!(flat.matches("BEGIN:VTIMEZONE").count(), 1);
        assert!(flat.contains("UID:weekly-standup-123@google.com\r\n"));
        assert!(flat.contains("DTSTAMP:20261016T080000Z\r\n"));
        assert!(flat.contains("SEQUENCE:0\r\n"));
        assert!(flat.contains("DTSTART;TZID=Europe/Berlin:20261005T090000\r\n"));
        assert!(flat.contains("ORGANIZER;CN=Alex Organizer:mailto:organizer@example.com\r\n"));
        assert!(flat.contains("COMMENT:Running late\\, see you there\r\n"));
        let vevent = &flat[flat.find("BEGIN:VEVENT").unwrap()..];
        assert!(!vevent.contains("RRULE") && !vevent.contains("RSVP=") && !vevent.contains("VALARM"));
        let parsed = parse_calendar(&reply);
        assert_eq!(parsed.method.as_deref(), Some("REPLY"));
        let attendees = &parsed.events[0].attendees;
        assert_eq!(attendees.len(), 1);
        assert_eq!((attendees[0].email.as_str(), attendees[0].partstat.as_str()), ("sam@example.com", "accepted"));
    }
}
