export interface Calendar {
  id: string;
  name: string;
  color: string;
  is_default: boolean;
  visible: boolean;
  sort_order: number;
  source: string;
}

export interface CalendarPatch {
  name?: string;
  color?: string;
  visible?: boolean;
  sort_order?: number;
  is_default?: boolean;
}

export interface EventRow {
  id: string;
  calendar_id: string;
  uid: string;
  recurrence_id: string | null;
  title: string;
  description: string;
  location: string;
  all_day: boolean;
  dtstart: string;
  dtend: string;
  tzid: string | null;
  rrule: string | null;
  exdates: string[];
  rdates: string[];
  status: "confirmed" | "tentative" | "cancelled";
  transparency: "opaque" | "transparent";
  sequence: number;
  organizer_email: string | null;
  organizer_name: string | null;
  is_organizer: boolean;
  my_partstat: string | null;
  account_id: string | null;
  ical_raw: string | null;
}

export interface Attendee {
  email: string;
  name: string;
  role: string;
  partstat: string;
  rsvp: boolean;
  comment: string;
}

export interface EventDetail {
  event: EventRow;
  alarms: number[];
  attendees: Attendee[];
  calendar_color: string;
}

/** Timed: `start`/`end` are UTC instants; all-day: local dates, end exclusive. */
export interface Occurrence {
  event_id: string;
  calendar_id: string;
  color: string;
  title: string;
  location: string;
  description: string;
  all_day: boolean;
  start: string;
  end: string;
  occurrence_key: string;
  is_recurring: boolean;
  is_override: boolean;
  status: string;
  my_partstat: string | null;
  is_organizer: boolean;
  has_attendees: boolean;
}

/** Timed: ISO instants (`Date.toISOString()`); all-day: `YYYY-MM-DD`, end exclusive. */
export interface EventTimes {
  all_day: boolean;
  start: string;
  end: string;
}

export interface EventInput {
  calendar_id: string;
  title: string;
  description?: string;
  location?: string;
  times: EventTimes;
  rrule?: string | null;
  alarms?: number[];
}

export interface EventPatch {
  calendar_id?: string;
  title?: string;
  description?: string;
  location?: string;
  times?: EventTimes;
  rrule?: string;
  clear_rrule?: boolean;
  alarms?: number[];
}

export type EditScope = "this" | "following" | "all";

export interface CalendarSettings {
  default_reminder_minutes: number | null;
  default_duration_minutes: number;
  work_start_hour: number;
  work_end_hour: number;
  /** 0 = Sunday … 6 = Saturday */
  work_days: number[];
}

export interface ImportResult {
  imported: number;
  updated: number;
  skipped: number;
}

export type CalendarViewKind = "month" | "week" | "workweek" | "day" | "agenda";

export interface EventDraft {
  title?: string;
  description?: string;
  location?: string;
  calendarId?: string;
  times: EventTimes;
}

export type EventEditorTarget =
  | { mode: "edit"; eventId: string; occurrenceKey: string | null; occurrence?: Occurrence }
  | { mode: "new"; draft: EventDraft };
