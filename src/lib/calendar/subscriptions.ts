import type { Calendar } from "../../types/calendar";

export const REFRESH_CHOICES = [15, 60, 360, 1440] as const;
export const DEFAULT_REFRESH_MINUTES = 60;

const REFRESH_KEYS: Record<number, string> = {
  15: "calendar.refresh.m15",
  60: "calendar.refresh.h1",
  360: "calendar.refresh.h6",
  1440: "calendar.refresh.d1",
};

export function refreshLabelKey(minutes: number): string {
  return REFRESH_KEYS[minutes] ?? REFRESH_KEYS[DEFAULT_REFRESH_MINUTES];
}

/** A quick check before the backend validates the link for real. */
export function looksLikeFeedLink(text: string): boolean {
  return /^(https|webcals?):\/\/[^\s/]+\.[^\s/]+/i.test(text.trim());
}

export type SyncState = { kind: "never" } | { kind: "ok"; at: Date } | { kind: "error"; error: string; lastOk: Date | null };

export function syncState(cal: Pick<Calendar, "last_synced_at" | "last_error">): SyncState {
  const lastOk = cal.last_synced_at ? new Date(cal.last_synced_at) : null;
  if (cal.last_error) return { kind: "error", error: cal.last_error, lastOk };
  return lastOk ? { kind: "ok", at: lastOk } : { kind: "never" };
}
