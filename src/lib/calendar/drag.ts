import { addDays, addMinutes, startOfDay } from "date-fns";
import type { EventTimes } from "../../types/calendar";
import { isoDate, MINUTES_PER_DAY, parseIsoDate } from "./dates";

export const SNAP_MINUTES = 15;

export function snapMinutes(min: number, snap = SNAP_MINUTES): number {
  return Math.min(MINUTES_PER_DAY, Math.max(0, Math.round(min / snap) * snap));
}

export function minutesFromOffset(offsetY: number, hourHeight: number, snap = SNAP_MINUTES): number {
  return snapMinutes((offsetY / hourHeight) * 60, snap);
}

/** Wall-clock minutes on `day`, so a DST day still lands on the hour the grid shows. */
export function atMinutes(day: Date, minutes: number): Date {
  const d = startOfDay(day);
  d.setHours(0, minutes, 0, 0);
  return d;
}

export function shiftTimed(start: Date, end: Date, deltaDays: number, deltaMinutes: number): { start: Date; end: Date } {
  return {
    start: addMinutes(addDays(start, deltaDays), deltaMinutes),
    end: addMinutes(addDays(end, deltaDays), deltaMinutes),
  };
}

export function resizedEnd(start: Date, day: Date, endMin: number, snap = SNAP_MINUTES): Date {
  const end = atMinutes(day, endMin);
  const min = addMinutes(start, snap);
  return end < min ? min : end;
}

export function shiftAllDay(startIso: string, endIso: string, days: number): { start: string; end: string } {
  return { start: isoDate(addDays(parseIsoDate(startIso), days)), end: isoDate(addDays(parseIsoDate(endIso), days)) };
}

export function timedPayload(start: Date, end: Date): EventTimes {
  return { all_day: false, start: start.toISOString(), end: end.toISOString() };
}

export function allDayPayload(start: string, end: string): EventTimes {
  return { all_day: true, start, end };
}

/** Index of the day under the pointer on a bar spanning `spanDays` equal-width days. */
export function grabbedDayIndex(clientX: number, left: number, width: number, spanDays: number): number {
  if (width <= 0 || spanDays <= 1) return 0;
  const idx = Math.floor(((clientX - left) / width) * spanDays);
  return Math.min(spanDays - 1, Math.max(0, idx));
}

export function parseOccurrenceDrag(raw: string): { id: string; grabbed: string | null } {
  try {
    const data: unknown = JSON.parse(raw);
    if (data && typeof data === "object" && typeof (data as { id?: unknown }).id === "string") {
      const { id, grabbed } = data as { id: string; grabbed?: unknown };
      return { id, grabbed: typeof grabbed === "string" ? grabbed : null };
    }
  } catch {
    // Older payloads carry the bare occurrence id.
  }
  return { id: raw, grabbed: null };
}

export function moveDueToDay(dueIso: string, day: Date): string {
  const due = new Date(dueIso);
  const moved = startOfDay(day);
  moved.setHours(due.getHours(), due.getMinutes(), due.getSeconds(), 0);
  return moved.toISOString();
}
