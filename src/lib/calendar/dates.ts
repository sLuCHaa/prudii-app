import { addDays, addMonths, addWeeks, endOfMonth, format, getISOWeek, getWeek, startOfDay, startOfMonth, startOfWeek } from "date-fns";
import type { Locale } from "date-fns";
import type { WeekDay } from "../localeDefaults";
import type { CalendarViewKind, Occurrence } from "../../types/calendar";

export const AGENDA_DAYS = 90;
export const MINUTES_PER_DAY = 1440;
const DAY_MS = 86_400_000;

/** Local calendar date (toISOString would give the UTC date). */
export function isoDate(d: Date): string {
  return format(d, "yyyy-MM-dd");
}

export function parseIsoDate(s: string): Date {
  const [y, m, d] = s.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** Rows of seven days covering the anchor's month. */
export function monthGrid(anchor: Date, weekStart: WeekDay): Date[][] {
  const last = endOfMonth(anchor);
  const weeks: Date[][] = [];
  let day = startOfWeek(startOfMonth(anchor), { weekStartsOn: weekStart });
  do {
    const row = Array.from({ length: 7 }, (_, i) => addDays(day, i));
    weeks.push(row);
    day = addDays(day, 7);
  } while (day <= last);
  return weeks;
}

export function viewDays(view: CalendarViewKind, anchor: Date, weekStart: WeekDay, workDays: number[]): Date[] {
  if (view === "day") return [startOfDay(anchor)];
  const first = startOfWeek(anchor, { weekStartsOn: weekStart });
  const week = Array.from({ length: 7 }, (_, i) => addDays(first, i));
  if (view !== "workweek") return week;
  const work = week.filter((d) => workDays.includes(d.getDay()));
  return work.length > 0 ? work : week;
}

export function visibleRange(
  view: CalendarViewKind,
  anchor: Date,
  weekStart: WeekDay,
  workDays: number[],
  agendaDays = AGENDA_DAYS,
): { from: Date; to: Date } {
  if (view === "month") {
    const weeks = monthGrid(anchor, weekStart);
    return { from: weeks[0][0], to: addDays(weeks[weeks.length - 1][6], 1) };
  }
  if (view === "agenda") {
    const from = startOfDay(anchor);
    return { from, to: addDays(from, agendaDays) };
  }
  const days = viewDays(view, anchor, weekStart, workDays);
  return { from: days[0], to: addDays(days[days.length - 1], 1) };
}

export function shiftAnchor(view: CalendarViewKind, anchor: Date, dir: 1 | -1): Date {
  switch (view) {
    case "month":
      return addMonths(anchor, dir);
    case "week":
    case "workweek":
      return addWeeks(anchor, dir);
    case "day":
      return addDays(anchor, dir);
    case "agenda":
      return addDays(anchor, dir * 30);
  }
}

export function weekNumber(d: Date, weekStart: WeekDay): number {
  return weekStart === 1 ? getISOWeek(d) : getWeek(d, { weekStartsOn: weekStart, firstWeekContainsDate: 1 });
}

// formatRange is ES2021 Intl; the project's TS lib is ES2020, the runtimes have it.
type RangeFormat = { formatRange(a: Date, b: Date): string };

export function viewTitle(
  view: CalendarViewKind,
  anchor: Date,
  weekStart: WeekDay,
  workDays: number[],
  locale: Locale,
  lang: string,
  labels: { week: (week: number, range: string) => string; agendaFrom: (date: string) => string },
): string {
  if (view === "month") return format(anchor, "LLLL yyyy", { locale });
  if (view === "day") return format(anchor, "PPPP", { locale });
  if (view === "agenda") return labels.agendaFrom(format(anchor, "PPP", { locale }));
  const days = viewDays(view, anchor, weekStart, workDays);
  const fmt = new Intl.DateTimeFormat(lang, { day: "numeric", month: "short" }) as unknown as RangeFormat;
  return labels.week(weekNumber(days[0], weekStart), fmt.formatRange(days[0], days[days.length - 1]));
}

export function occurrenceRange(o: Occurrence): { start: Date; end: Date } {
  if (o.all_day) return { start: parseIsoDate(o.start), end: parseIsoDate(o.end) };
  return { start: new Date(o.start), end: new Date(o.end) };
}

/** All-day events and timed events of a day or longer sit in the lane above the time grid. */
export function isLaneEvent(o: Occurrence): boolean {
  if (o.all_day) return true;
  const { start, end } = occurrenceRange(o);
  return end.getTime() - start.getTime() >= DAY_MS;
}

export function occursOnDay(o: Occurrence, day: Date): boolean {
  const { start, end } = occurrenceRange(o);
  const ds = startOfDay(day);
  const de = addDays(ds, 1);
  if (start.getTime() === end.getTime()) return start >= ds && start < de;
  return start < de && end > ds;
}

const wallMinutes = (d: Date) => d.getHours() * 60 + d.getMinutes();

/** The part of a timed occurrence on `day`, in wall-clock minutes from midnight. */
export function daySegment(o: Occurrence, day: Date): { startMin: number; endMin: number } | null {
  if (!occursOnDay(o, day)) return null;
  const { start, end } = occurrenceRange(o);
  const ds = startOfDay(day);
  const de = addDays(ds, 1);
  const startMin = start <= ds ? 0 : wallMinutes(start);
  const endMin = end >= de ? MINUTES_PER_DAY : wallMinutes(end);
  return { startMin, endMin: Math.max(endMin, startMin) };
}

/** First and last index in `days` the occurrence touches. */
export function spanInDays(o: Occurrence, days: Date[]): { startIdx: number; endIdx: number } | null {
  const hits = days.map((d, i) => (occursOnDay(o, d) ? i : -1)).filter((i) => i >= 0);
  return hits.length ? { startIdx: hits[0], endIdx: hits[hits.length - 1] } : null;
}
