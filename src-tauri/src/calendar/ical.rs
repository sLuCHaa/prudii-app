//! VEVENT ⇄ calendar rows. Parsed times are normalised into the event's own
//! frame: wall clock in its IANA zone, or a date for all-day events.

use super::content_line::{escape_text, parse_components, parse_duration, write_prop, Component, Prop};
use super::tz::{fmt_date, fmt_wall, parse_date, parse_wall, resolve_tzid, system_tz, utc_to_wall, wall_to_utc};
use super::{Attendee, EventRow};
use chrono::{DateTime, Duration, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedAttendee {
    pub email: String,
    pub name: String,
    pub role: String,
    pub partstat: String,
    pub rsvp: bool,
}

impl From<&ParsedAttendee> for Attendee {
    fn from(a: &ParsedAttendee) -> Self {
        Attendee {
            email: a.email.clone(),
            name: a.name.clone(),
            role: a.role.clone(),
            partstat: a.partstat.clone(),
            rsvp: a.rsvp,
            comment: String::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ParsedEvent {
    pub uid: String,
    pub recurrence_id: Option<String>,
    pub title: String,
    pub description: String,
    pub location: String,
    pub all_day: bool,
    pub dtstart: String,
    pub dtend: String,
    pub tzid: Option<String>,
    pub rrule: Option<String>,
    pub exdates: Vec<String>,
    pub rdates: Vec<String>,
    pub status: String,
    pub transparency: String,
    pub sequence: i64,
    pub organizer_email: Option<String>,
    pub organizer_name: Option<String>,
    pub attendees: Vec<ParsedAttendee>,
    pub alarms: Vec<i64>,
    pub raw: String,
}

impl ParsedEvent {
    pub fn to_row(&self, id: String, calendar_id: String) -> EventRow {
        EventRow {
            id,
            calendar_id,
            uid: self.uid.clone(),
            recurrence_id: self.recurrence_id.clone(),
            title: self.title.clone(),
            description: self.description.clone(),
            location: self.location.clone(),
            all_day: self.all_day,
            dtstart: self.dtstart.clone(),
            dtend: self.dtend.clone(),
            tzid: self.tzid.clone(),
            rrule: self.rrule.clone(),
            exdates: self.exdates.clone(),
            rdates: self.rdates.clone(),
            status: self.status.clone(),
            transparency: self.transparency.clone(),
            sequence: self.sequence,
            organizer_email: self.organizer_email.clone(),
            organizer_name: self.organizer_name.clone(),
            is_organizer: false,
            my_partstat: None,
            account_id: None,
            ical_raw: Some(self.raw.clone()),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct ParsedCalendar {
    pub method: Option<String>,
    pub name: Option<String>,
    pub events: Vec<ParsedEvent>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum DateValue {
    Date(NaiveDate),
    Utc(NaiveDateTime),
    Local(NaiveDateTime),
}

/// The zone an event's local times are written in.
#[derive(Debug, Clone, Copy)]
enum Frame {
    AllDay,
    Zone(Tz),
    Floating,
    /// Unknown zone: times are converted to UTC with this offset (seconds east).
    Fixed(i32),
}

fn parse_one(v: &str) -> Option<DateValue> {
    let v = v.trim();
    if v.len() == 8 {
        return NaiveDate::parse_from_str(v, "%Y%m%d").ok().map(DateValue::Date);
    }
    if let Some(utc) = v.strip_suffix('Z').or_else(|| v.strip_suffix('z')) {
        return NaiveDateTime::parse_from_str(utc, "%Y%m%dT%H%M%S").ok().map(DateValue::Utc);
    }
    NaiveDateTime::parse_from_str(v, "%Y%m%dT%H%M%S").ok().map(DateValue::Local)
}

fn naive_of(v: DateValue) -> NaiveDateTime {
    match v {
        DateValue::Date(d) => d.and_hms_opt(0, 0, 0).expect("midnight is valid"),
        DateValue::Utc(n) | DateValue::Local(n) => n,
    }
}

fn parse_utc_offset(v: &str) -> Option<i32> {
    let v = v.trim();
    let sign = match v.chars().next()? {
        '+' => 1,
        '-' => -1,
        _ => return None,
    };
    let digits = &v[1..];
    if digits.len() < 4 || !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let h: i32 = digits[0..2].parse().ok()?;
    let m: i32 = digits[2..4].parse().ok()?;
    let s: i32 = if digits.len() >= 6 { digits[4..6].parse().ok()? } else { 0 };
    Some(sign * (h * 3600 + m * 60 + s))
}

/// Offset of an unknown zone from its VTIMEZONE (STANDARD first). DST shifts of
/// such one-off zones are not modelled.
fn fixed_offset(tzid: &str, timezones: &[Component]) -> Option<i32> {
    let vtz = timezones
        .iter()
        .find(|c| c.prop("TZID").map(|p| p.value.trim() == tzid.trim()).unwrap_or(false))?;
    let sub = vtz.children.iter().find(|c| c.name == "STANDARD").or_else(|| vtz.children.first())?;
    parse_utc_offset(&sub.prop("TZOFFSETTO")?.value)
}

fn frame_for(dtstart: &Prop, first: DateValue, timezones: &[Component]) -> Frame {
    match first {
        DateValue::Date(_) => Frame::AllDay,
        DateValue::Utc(_) => Frame::Zone(Tz::UTC),
        DateValue::Local(_) => match dtstart.param("TZID") {
            None => Frame::Floating,
            Some(id) => match resolve_tzid(id) {
                Some(tz) => Frame::Zone(tz),
                None => fixed_offset(id, timezones).map(Frame::Fixed).unwrap_or(Frame::Floating),
            },
        },
    }
}

fn frame_tzid(frame: Frame) -> Option<String> {
    match frame {
        Frame::AllDay | Frame::Floating => None,
        Frame::Zone(tz) => Some(tz.name().to_string()),
        Frame::Fixed(_) => Some("UTC".into()),
    }
}

/// The instant a value names, if it names one (dates and floating values do not).
fn to_utc(value: DateValue, tzid: Option<&str>, timezones: &[Component]) -> Option<DateTime<Utc>> {
    match value {
        DateValue::Utc(n) => Some(Utc.from_utc_datetime(&n)),
        DateValue::Date(_) => None,
        DateValue::Local(n) => {
            let id = tzid?;
            if let Some(tz) = resolve_tzid(id) {
                return Some(wall_to_utc(&tz, n));
            }
            fixed_offset(id, timezones).map(|off| Utc.from_utc_datetime(&(n - Duration::seconds(off as i64))))
        }
    }
}

fn to_frame(value: DateValue, prop_tzid: Option<&str>, frame: Frame, timezones: &[Component]) -> String {
    match frame {
        Frame::AllDay => fmt_date(naive_of(value).date()),
        Frame::Zone(tz) => fmt_wall(
            to_utc(value, prop_tzid, timezones).map(|u| utc_to_wall(&tz, u)).unwrap_or_else(|| naive_of(value)),
        ),
        Frame::Floating => match value {
            DateValue::Utc(n) => fmt_wall(utc_to_wall(&system_tz(), Utc.from_utc_datetime(&n))),
            other => fmt_wall(naive_of(other)),
        },
        Frame::Fixed(offset) => match value {
            DateValue::Utc(n) => fmt_wall(n),
            other => fmt_wall(naive_of(other) - Duration::seconds(offset as i64)),
        },
    }
}

fn shift(value: &str, all_day: bool, by: Duration) -> String {
    if all_day {
        parse_date(value).map(|d| fmt_date(d + Duration::days(by.num_days()))).unwrap_or_else(|| value.to_string())
    } else {
        parse_wall(value).map(|w| fmt_wall(w + by)).unwrap_or_else(|| value.to_string())
    }
}

fn date_list(c: &Component, name: &str, frame: Frame, timezones: &[Component]) -> Vec<String> {
    let mut out = Vec::new();
    for p in c.props_named(name) {
        if p.param("VALUE").map(|v| v.eq_ignore_ascii_case("PERIOD")).unwrap_or(false) {
            continue;
        }
        for v in p.value.split(',') {
            if let Some(dv) = parse_one(v) {
                out.push(to_frame(dv, p.param("TZID"), frame, timezones));
            }
        }
    }
    out
}

fn strip_mailto(v: &str) -> String {
    let v = v.trim();
    let lower = v.to_ascii_lowercase();
    if lower.starts_with("mailto:") { v[7..].to_string() } else { v.to_string() }
}

fn lower_or(p: Option<&str>, default: &str) -> String {
    p.map(|v| v.to_ascii_lowercase()).unwrap_or_else(|| default.to_string())
}

/// Feeds re-send UID-less events on every refresh; a stable stand-in keeps them one row.
fn fallback_uid(c: &Component) -> String {
    use sha2::{Digest, Sha256};
    let value = |name: &str| c.prop(name).map(|p| p.value.as_str()).unwrap_or("");
    let key = format!("{}|{}|{}", value("DTSTART"), value("SUMMARY"), value("RRULE"));
    let hex: String = Sha256::digest(key.as_bytes()).iter().take(12).map(|b| format!("{:02x}", b)).collect();
    format!("{}@prudii", hex)
}

fn parse_event(c: &Component, timezones: &[Component]) -> Option<ParsedEvent> {
    let start_prop = c.prop("DTSTART")?;
    let mut start_val = parse_one(start_prop.value.split(',').next()?)?;
    if start_prop.param("VALUE").map(|v| v.eq_ignore_ascii_case("DATE")).unwrap_or(false) {
        start_val = DateValue::Date(naive_of(start_val).date());
    }
    let frame = frame_for(start_prop, start_val, timezones);
    let all_day = matches!(frame, Frame::AllDay);
    let dtstart = to_frame(start_val, start_prop.param("TZID"), frame, timezones);

    let explicit_end = c
        .prop("DTEND")
        .and_then(|p| parse_one(&p.value).map(|v| to_frame(v, p.param("TZID"), frame, timezones)));
    let by_duration = || {
        let secs = parse_duration(&c.prop("DURATION")?.value)?;
        Some(shift(&dtstart, all_day, Duration::seconds(secs)))
    };
    let mut dtend = explicit_end
        .or_else(by_duration)
        .unwrap_or_else(|| if all_day { shift(&dtstart, true, Duration::days(1)) } else { dtstart.clone() });
    if dtend < dtstart || (all_day && dtend == dtstart) {
        dtend = if all_day { shift(&dtstart, true, Duration::days(1)) } else { dtstart.clone() };
    }

    let recurrence_id = c
        .prop("RECURRENCE-ID")
        .and_then(|p| parse_one(&p.value).map(|v| to_frame(v, p.param("TZID"), frame, timezones)));

    let alarms = {
        let mut v: Vec<i64> = c
            .children
            .iter()
            .filter(|a| a.name == "VALARM")
            .filter_map(|a| {
                let trigger = a.prop("TRIGGER")?;
                if trigger.param("VALUE").map(|v| v.eq_ignore_ascii_case("DATE-TIME")).unwrap_or(false)
                    || trigger.param("RELATED").map(|v| v.eq_ignore_ascii_case("END")).unwrap_or(false)
                {
                    return None;
                }
                let secs = parse_duration(&trigger.value)?;
                (secs <= 0).then_some(-secs / 60)
            })
            .collect();
        v.sort_unstable();
        v.dedup();
        v
    };

    let organizer = c.prop("ORGANIZER");
    Some(ParsedEvent {
        uid: c
            .text("UID")
            .map(|u| u.trim().to_string())
            .filter(|u| !u.is_empty())
            .unwrap_or_else(|| fallback_uid(c)),
        recurrence_id,
        title: c.text("SUMMARY").unwrap_or_default(),
        description: c.text("DESCRIPTION").unwrap_or_default().trim_end().to_string(),
        location: c.text("LOCATION").unwrap_or_default(),
        all_day,
        dtend,
        tzid: frame_tzid(frame),
        rrule: c.prop("RRULE").map(|p| p.value.trim().to_string()).filter(|r| !r.is_empty()),
        exdates: date_list(c, "EXDATE", frame, timezones),
        rdates: date_list(c, "RDATE", frame, timezones),
        status: match c.prop("STATUS").map(|p| p.value.trim().to_ascii_uppercase()).as_deref() {
            Some("TENTATIVE") => "tentative".into(),
            Some("CANCELLED") => "cancelled".into(),
            _ => "confirmed".into(),
        },
        transparency: match c.prop("TRANSP").map(|p| p.value.trim().to_ascii_uppercase()).as_deref() {
            Some("TRANSPARENT") => "transparent".into(),
            _ => "opaque".into(),
        },
        sequence: c.prop("SEQUENCE").and_then(|p| p.value.trim().parse().ok()).unwrap_or(0),
        organizer_email: organizer.map(|p| strip_mailto(&p.value)).filter(|e| !e.is_empty()),
        organizer_name: organizer.and_then(|p| p.param("CN")).map(str::to_string),
        attendees: c
            .props_named("ATTENDEE")
            .map(|p| ParsedAttendee {
                email: strip_mailto(&p.value),
                name: p.param("CN").unwrap_or_default().to_string(),
                role: lower_or(p.param("ROLE"), "req-participant"),
                partstat: lower_or(p.param("PARTSTAT"), "needs-action"),
                rsvp: p.param("RSVP").map(|v| v.eq_ignore_ascii_case("TRUE")).unwrap_or(false),
            })
            .filter(|a| !a.email.is_empty())
            .collect(),
        alarms,
        raw: c.raw.clone(),
        dtstart,
    })
}

pub fn parse_calendar(text: &str) -> ParsedCalendar {
    let mut cal = ParsedCalendar::default();
    let mut timezones = Vec::new();
    let mut vevents = Vec::new();
    for root in parse_components(text) {
        match root.name.as_str() {
            "VCALENDAR" => {
                if cal.method.is_none() {
                    cal.method = root.prop("METHOD").map(|p| p.value.trim().to_ascii_uppercase());
                }
                if cal.name.is_none() {
                    cal.name = root.text("X-WR-CALNAME");
                }
                for child in root.children {
                    match child.name.as_str() {
                        "VTIMEZONE" => timezones.push(child),
                        "VEVENT" => vevents.push(child),
                        _ => {}
                    }
                }
            }
            "VEVENT" => vevents.push(root),
            _ => {}
        }
    }
    cal.events = vevents.iter().filter_map(|c| parse_event(c, &timezones)).collect();
    cal
}

pub struct ExportEvent<'a> {
    pub row: &'a EventRow,
    pub alarms: &'a [i64],
    pub attendees: &'a [Attendee],
}

const KNOWN_PROPS: &[&str] = &[
    "UID", "DTSTAMP", "DTSTART", "DTEND", "DURATION", "SUMMARY", "DESCRIPTION", "LOCATION", "RRULE", "EXDATE",
    "RDATE", "RECURRENCE-ID", "STATUS", "TRANSP", "SEQUENCE", "ORGANIZER", "ATTENDEE", "CREATED", "LAST-MODIFIED",
];

fn compact(value: &str) -> String {
    value.replace(['-', ':'], "")
}

/// Single timed events go out in UTC so no VTIMEZONE is needed; series keep
/// their zone so they stay right across DST changes.
fn time_line(name: &str, value: &str, row: &EventRow, use_utc: bool) -> String {
    if row.all_day {
        return write_prop(name, &[("VALUE", "DATE")], &compact(value));
    }
    match row.tzid.as_deref() {
        Some("UTC") => write_prop(name, &[], &format!("{}Z", compact(value))),
        Some(tzid) if use_utc => match (resolve_tzid(tzid), parse_wall(value)) {
            (Some(tz), Some(wall)) => write_prop(name, &[], &wall_to_utc(&tz, wall).format("%Y%m%dT%H%M%SZ").to_string()),
            _ => write_prop(name, &[("TZID", tzid)], &compact(value)),
        },
        Some(tzid) => write_prop(name, &[("TZID", tzid)], &compact(value)),
        None => write_prop(name, &[], &compact(value)),
    }
}

fn extra_props(raw: &str) -> Vec<Prop> {
    parse_components(raw)
        .into_iter()
        .find(|c| c.name == "VEVENT")
        .map(|c| c.props.into_iter().filter(|p| !KNOWN_PROPS.contains(&p.name.as_str())).collect())
        .unwrap_or_default()
}

pub fn event_to_ics(e: &ExportEvent, dtstamp: DateTime<Utc>) -> String {
    let r = e.row;
    let use_utc = r.rrule.is_none() && r.rdates.is_empty() && r.recurrence_id.is_none();
    let mut out = String::from("BEGIN:VEVENT\r\n");
    out += &write_prop("UID", &[], &escape_text(&r.uid));
    out += &write_prop("DTSTAMP", &[], &dtstamp.format("%Y%m%dT%H%M%SZ").to_string());
    out += &time_line("DTSTART", &r.dtstart, r, use_utc);
    out += &time_line("DTEND", &r.dtend, r, use_utc);
    if let Some(rid) = &r.recurrence_id {
        out += &time_line("RECURRENCE-ID", rid, r, false);
    }
    if let Some(rule) = &r.rrule {
        out += &write_prop("RRULE", &[], rule);
    }
    for x in &r.exdates {
        out += &time_line("EXDATE", x, r, false);
    }
    for x in &r.rdates {
        out += &time_line("RDATE", x, r, false);
    }
    out += &write_prop("SUMMARY", &[], &escape_text(&r.title));
    if !r.description.is_empty() {
        out += &write_prop("DESCRIPTION", &[], &escape_text(&r.description));
    }
    if !r.location.is_empty() {
        out += &write_prop("LOCATION", &[], &escape_text(&r.location));
    }
    out += &write_prop("STATUS", &[], &r.status.to_ascii_uppercase());
    out += &write_prop("TRANSP", &[], &r.transparency.to_ascii_uppercase());
    out += &write_prop("SEQUENCE", &[], &r.sequence.to_string());
    if let Some(email) = &r.organizer_email {
        let params: Vec<(&str, &str)> = r.organizer_name.as_deref().map(|n| vec![("CN", n)]).unwrap_or_default();
        out += &write_prop("ORGANIZER", &params, &format!("mailto:{}", email));
    }
    for a in e.attendees {
        let role = a.role.to_ascii_uppercase();
        let partstat = a.partstat.to_ascii_uppercase();
        let mut params: Vec<(&str, &str)> = Vec::new();
        if !a.name.is_empty() {
            params.push(("CN", &a.name));
        }
        params.push(("ROLE", &role));
        params.push(("PARTSTAT", &partstat));
        params.push(("RSVP", if a.rsvp { "TRUE" } else { "FALSE" }));
        out += &write_prop("ATTENDEE", &params, &format!("mailto:{}", a.email));
    }
    if let Some(raw) = &r.ical_raw {
        for p in extra_props(raw) {
            let params: Vec<(&str, &str)> = p.params.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect();
            out += &write_prop(&p.name, &params, &p.value);
        }
    }
    for minutes in e.alarms {
        out += "BEGIN:VALARM\r\nACTION:DISPLAY\r\n";
        out += &write_prop("DESCRIPTION", &[], &escape_text(&r.title));
        let trigger = if *minutes == 0 { "PT0S".to_string() } else { format!("-PT{}M", minutes) };
        out += &write_prop("TRIGGER", &[], &trigger);
        out += "END:VALARM\r\n";
    }
    out += "END:VEVENT\r\n";
    out
}

pub fn calendar_to_ics(events: &[ExportEvent], name: Option<&str>, method: Option<&str>, dtstamp: DateTime<Utc>) -> String {
    let mut out = String::from("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Prudii//Prudii Mail//EN\r\nCALSCALE:GREGORIAN\r\n");
    if let Some(m) = method {
        out += &write_prop("METHOD", &[], m);
    }
    if let Some(n) = name {
        out += &write_prop("X-WR-CALNAME", &[], &escape_text(n));
    }
    for e in events {
        out += &event_to_ics(e, dtstamp);
    }
    out += "END:VCALENDAR\r\n";
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::calendar::content_line::parse_components;

    const GOOGLE: &str = include_str!("fixtures/google_weekly.ics");
    const OUTLOOK: &str = include_str!("fixtures/outlook_windows_tz.ics");
    const APPLE: &str = include_str!("fixtures/apple_allday.ics");

    #[test]
    fn parses_a_google_weekly_invitation() {
        let cal = parse_calendar(GOOGLE);
        assert_eq!(cal.method.as_deref(), Some("REQUEST"));
        let e = &cal.events[0];
        assert_eq!(e.uid, "weekly-standup-123@google.com");
        assert_eq!(e.title, "Team standup");
        assert_eq!(e.description, "Weekly sync, agenda in the doc.\nJoin: https://meet.google.com/abc-defg-hij");
        assert!(!e.all_day);
        assert_eq!(e.tzid.as_deref(), Some("Europe/Berlin"));
        assert_eq!(e.dtstart, "2026-10-05T09:00:00");
        assert_eq!(e.dtend, "2026-10-05T09:30:00");
        assert_eq!(e.rrule.as_deref(), Some("FREQ=WEEKLY;BYDAY=MO"));
        assert_eq!(e.exdates, vec!["2026-10-12T09:00:00".to_string()]);
        assert_eq!(e.organizer_email.as_deref(), Some("organizer@example.com"));
        assert_eq!(e.organizer_name.as_deref(), Some("Alex Organizer"));
        assert_eq!(e.attendees.len(), 2);
        assert_eq!(e.attendees[0], ParsedAttendee {
            email: "sam@example.com".into(),
            name: "Sam Example".into(),
            role: "req-participant".into(),
            partstat: "needs-action".into(),
            rsvp: true,
        });
        assert_eq!(e.alarms, vec![10]);
        assert_eq!(e.status, "confirmed");
        assert!(e.raw.starts_with("BEGIN:VEVENT"));
    }

    #[test]
    fn maps_outlook_windows_zone_names_to_iana() {
        let e = &parse_calendar(OUTLOOK).events[0];
        assert_eq!(e.tzid.as_deref(), Some("Europe/Berlin"));
        assert_eq!(e.dtstart, "2026-10-20T14:00:00");
        assert_eq!(e.dtend, "2026-10-20T15:30:00");
        assert_eq!(e.sequence, 2);
        assert_eq!(e.location, "Room 4.12");
        assert_eq!(e.alarms, vec![15]);
    }

    #[test]
    fn handles_all_day_durations_and_floating_times() {
        let cal = parse_calendar(APPLE);
        assert_eq!(cal.name.as_deref(), Some("Holidays"));
        let holidays = &cal.events[0];
        assert!(holidays.all_day);
        assert_eq!((holidays.dtstart.as_str(), holidays.dtend.as_str()), ("2026-12-24", "2026-12-27"));
        assert_eq!(holidays.tzid, None);
        assert_eq!(holidays.transparency, "transparent");
        let floating = &cal.events[1];
        assert_eq!(floating.tzid, None);
        assert_eq!(floating.dtstart, "2026-11-01T08:00:00");
    }

    #[test]
    fn unknown_zone_falls_back_to_the_vtimezone_offset() {
        let text = "BEGIN:VCALENDAR\nBEGIN:VTIMEZONE\nTZID:Custom Zone\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+0530\nTZOFFSETTO:+0530\nEND:STANDARD\nEND:VTIMEZONE\nBEGIN:VEVENT\nUID:custom-1\nDTSTART;TZID=Custom Zone:20261015T103000\nDTEND;TZID=Custom Zone:20261015T113000\nSUMMARY:Call\nEND:VEVENT\nEND:VCALENDAR\n";
        let e = &parse_calendar(text).events[0];
        assert_eq!(e.tzid.as_deref(), Some("UTC"));
        assert_eq!(e.dtstart, "2026-10-15T05:00:00");
        assert_eq!(e.dtend, "2026-10-15T06:00:00");
    }

    #[test]
    fn utc_values_get_the_utc_zone_and_missing_uid_is_generated() {
        let text = "BEGIN:VEVENT\nDTSTART:20261015T070000Z\nDTEND:20261015T080000Z\nSUMMARY:x\nEND:VEVENT\n";
        let e = &parse_calendar(text).events[0];
        assert_eq!(e.tzid.as_deref(), Some("UTC"));
        assert_eq!(e.dtstart, "2026-10-15T07:00:00");
        assert!(e.uid.ends_with("@prudii"));
    }

    #[test]
    fn round_trips_through_export_keeping_unknown_properties() {
        let parsed = &parse_calendar(GOOGLE).events[0];
        let row = parsed.to_row("id-1".into(), "cal-1".into());
        let attendees: Vec<Attendee> = parsed.attendees.iter().map(Attendee::from).collect();
        let ics = calendar_to_ics(
            &[ExportEvent { row: &row, alarms: &parsed.alarms, attendees: &attendees }],
            Some("Work"),
            None,
            chrono::Utc::now(),
        );
        let again = parse_calendar(&ics);
        assert_eq!(again.name.as_deref(), Some("Work"));
        let e = &again.events[0];
        assert_eq!((e.dtstart.as_str(), e.tzid.as_deref()), ("2026-10-05T09:00:00", Some("Europe/Berlin")));
        assert_eq!(e.rrule, parsed.rrule);
        assert_eq!(e.exdates, parsed.exdates);
        assert_eq!(e.description, parsed.description);
        assert_eq!(e.attendees, parsed.attendees);
        assert_eq!(e.alarms, vec![10]);
        let vevent = parse_components(&ics)[0].children[0].clone();
        assert_eq!(vevent.prop("X-GOOGLE-CONFERENCE").map(|p| p.value.as_str()), Some("https://meet.google.com/abc-defg-hij"));
        assert!(vevent.prop("CREATED").is_none(), "known properties are regenerated, not copied");
    }

    #[test]
    fn single_timed_events_export_in_utc() {
        let parsed = &parse_calendar(OUTLOOK).events[0];
        let row = parsed.to_row("id".into(), "cal".into());
        let ics = event_to_ics(&ExportEvent { row: &row, alarms: &[], attendees: &[] }, chrono::Utc::now());
        assert!(ics.contains("DTSTART:20261020T120000Z\r\n"), "{ics}");
        assert!(ics.contains("DTEND:20261020T133000Z\r\n"));
    }

    #[test]
    fn missing_uids_are_stable_across_fetches() {
        let first = "BEGIN:VEVENT
DTSTAMP:20261015T080000Z
DTSTART:20261015T070000Z
SUMMARY:Gym
END:VEVENT
";
        let later = first.replace("DTSTAMP:20261015T080000Z", "DTSTAMP:20261016T120000Z");
        let other = first.replace("SUMMARY:Gym", "SUMMARY:Swim");
        let uid = |t: &str| parse_calendar(t).events[0].uid.clone();
        assert_eq!(uid(first), uid(&later));
        assert_ne!(uid(first), uid(&other));
        assert!(uid(first).ends_with("@prudii"));
    }
}
