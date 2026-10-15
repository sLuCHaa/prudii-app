//! Local calendar: models, iCalendar mapping, recurrence expansion and storage.

pub mod content_line;
pub mod ical;
pub mod recurrence;
pub mod tz;
pub mod windows_zones;

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Calendar {
    pub id: String,
    pub name: String,
    pub color: String,
    pub is_default: bool,
    pub visible: bool,
    pub sort_order: f64,
    pub source: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct CalendarPatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub visible: Option<bool>,
    #[serde(default)]
    pub sort_order: Option<f64>,
    #[serde(default)]
    pub is_default: Option<bool>,
}

/// One `events` row. Times are wall clock in `tzid` ("2026-10-15T09:00:00"; floating
/// when `tzid` is None), or dates ("2026-10-15", end exclusive) when `all_day`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventRow {
    pub id: String,
    pub calendar_id: String,
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
    pub is_organizer: bool,
    pub my_partstat: Option<String>,
    pub account_id: Option<String>,
    pub ical_raw: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Attendee {
    pub email: String,
    pub name: String,
    pub role: String,
    pub partstat: String,
    pub rsvp: bool,
    pub comment: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EventDetail {
    pub event: EventRow,
    pub alarms: Vec<i64>,
    pub attendees: Vec<Attendee>,
    pub calendar_color: String,
}

/// One concrete slot as the views render it. Timed: `start`/`end` are UTC instants;
/// all-day: dates with an exclusive end.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Occurrence {
    pub event_id: String,
    pub calendar_id: String,
    pub color: String,
    pub title: String,
    pub location: String,
    pub description: String,
    pub all_day: bool,
    pub start: String,
    pub end: String,
    /// The slot's original wall-clock start (RECURRENCE-ID); scope edits key on it.
    pub occurrence_key: String,
    pub is_recurring: bool,
    pub is_override: bool,
    pub status: String,
    pub my_partstat: Option<String>,
    pub is_organizer: bool,
    pub has_attendees: bool,
}

/// Times as the UI sends them: UTC instants for timed events, local dates
/// (end exclusive) for all-day events.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventTimes {
    pub all_day: bool,
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct EventInput {
    pub calendar_id: String,
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub location: String,
    pub times: EventTimes,
    #[serde(default)]
    pub rrule: Option<String>,
    #[serde(default)]
    pub alarms: Vec<i64>,
}

#[derive(Debug, Clone, Default, Deserialize)]
pub struct EventPatch {
    #[serde(default)]
    pub calendar_id: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub times: Option<EventTimes>,
    #[serde(default)]
    pub rrule: Option<String>,
    #[serde(default)]
    pub clear_rrule: bool,
    #[serde(default)]
    pub alarms: Option<Vec<i64>>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    This,
    Following,
    All,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CalendarSettings {
    /// None = no reminder for new timed events.
    pub default_reminder_minutes: Option<i64>,
    pub default_duration_minutes: i64,
    pub work_start_hour: u32,
    pub work_end_hour: u32,
    /// 0 = Sunday … 6 = Saturday, as date-fns numbers them.
    pub work_days: Vec<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ImportResult {
    pub imported: u32,
    pub updated: u32,
    pub skipped: u32,
}
