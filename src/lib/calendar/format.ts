import { addDays, format, isSameDay } from "date-fns";
import type { CalendarSettings, EventTimes, Occurrence } from "../../types/calendar";
import { dateLocale, formatTime } from "../dateUtils";
import { isoDate, occurrenceRange } from "./dates";

export const DEFAULT_SETTINGS: CalendarSettings = {
  default_reminder_minutes: 15,
  default_duration_minutes: 60,
  work_start_hour: 8,
  work_end_hour: 18,
  work_days: [1, 2, 3, 4, 5],
};

export function formatOccurrenceTime(o: Pick<Occurrence, "all_day" | "start" | "end">, use24h: boolean, allDayLabel: string): string {
  if (o.all_day) return allDayLabel;
  const { start, end } = occurrenceRange(o);
  if (isSameDay(start, end)) return `${formatTime(start, use24h)} – ${formatTime(end, use24h)}`;
  const day = (d: Date) => format(d, "d MMM", { locale: dateLocale() });
  return `${day(start)}, ${formatTime(start, use24h)} – ${day(end)}, ${formatTime(end, use24h)}`;
}

export function formatSpan(span: Pick<Occurrence, "all_day" | "start" | "end">, use24h: boolean, allDayLabel: string): string {
  const { start } = occurrenceRange(span);
  return `${format(start, "EEE d MMM", { locale: dateLocale() })}, ${formatOccurrenceTime(span, use24h, allDayLabel)}`;
}

/** New-event times: the next full hour today, 09:00 on any other day. */
export function defaultDraftTimes(day: Date, settings: CalendarSettings, allDay = false, now = new Date()): EventTimes {
  if (allDay) return { all_day: true, start: isoDate(day), end: isoDate(addDays(day, 1)) };
  const start = new Date(day);
  if (isSameDay(day, now)) start.setHours(now.getHours() + 1, 0, 0, 0);
  else start.setHours(9, 0, 0, 0);
  const end = new Date(start.getTime() + settings.default_duration_minutes * 60_000);
  return { all_day: false, start: start.toISOString(), end: end.toISOString() };
}
