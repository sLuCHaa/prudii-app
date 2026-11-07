import type { SyncProgress } from "../types";
import { syncPercent } from "./syncProgress";

/**
 * The light edge under "Prudii Mail": one segment per account that is
 * syncing, in that account's colour. Push syncs are over in a few hundred
 * milliseconds; showing the line for them would flicker with every mail, so
 * an account only gets a segment once its sync has run for REVEAL_MS (or the
 * user asked for the sync).
 */
export const REVEAL_MS = 400;
/** How long the finished line stays lit before it fades. */
export const LINGER_MS = 450;
/** How long "+N" or "✓" stays next to the account. */
export const CHIP_MS = 1900;
/** A long sync shows how far it is; a short one would only flash a number. */
export const PERCENT_AFTER_MS = 1500;

export type LineOutcome = "running" | "done" | "error";

export interface LineEntry {
  since: number;
  shown: boolean;
  outcome: LineOutcome;
  ended: number | null;
  /** null while the sync does not know its size yet (connecting, listing folders). */
  percent: number | null;
  newMails: number;
}

export type LineState = Record<string, LineEntry>;

export interface LineSegment {
  accountId: string;
  percent: number | null;
  state: "running" | "fin" | "error";
}

export type LineChip = { kind: "new"; count: number } | { kind: "ok" } | null;

const isRunning = (p: SyncProgress) => p.status !== "done" && p.status !== "error" && p.status !== "skipped";

export function advanceLine(
  prev: LineState,
  progress: Record<string, SyncProgress | null | undefined>,
  now: number,
  revealAll = false,
): LineState {
  const next: LineState = {};
  for (const id of new Set([...Object.keys(prev), ...Object.keys(progress)])) {
    const p = progress[id] ?? null;
    const old = prev[id];

    if (p && isRunning(p)) {
      const continuing = old?.outcome === "running";
      // "connecting" opens a new run inside a running one; its size starts over.
      const carried = continuing && p.status !== "connecting" ? old.percent : null;
      const percent = p.folder_count > 0 ? Math.max(carried ?? 0, syncPercent(p)) : carried;
      const since = continuing ? old.since : now;
      next[id] = {
        since,
        shown: (continuing && old.shown) || revealAll || now - since >= REVEAL_MS,
        outcome: "running",
        ended: null,
        percent,
        newMails: Math.max(continuing ? old.newMails : 0, p.new_mails ?? 0),
      };
    } else if (p?.status === "done") {
      // The store repeats the same "done" until it clears it.
      next[id] = old?.outcome === "done"
        ? old
        : { since: old?.since ?? now, shown: old?.shown ?? false, outcome: "done", ended: now, percent: 100, newMails: p.new_mails ?? 0 };
    } else if (p?.status === "error") {
      next[id] = old?.outcome === "error"
        ? old
        : { since: old?.since ?? now, shown: true, outcome: "error", ended: now, percent: old?.percent ?? null, newMails: 0 };
    } else if (old && old.outcome !== "running" && old.ended !== null && now - old.ended < CHIP_MS) {
      // Cleared from the store: keep the finished entry until its chip has played.
      next[id] = old;
    }
  }
  return next;
}

/**
 * Segments in account order. Finished and failed accounts stay lit while the
 * run they belong to goes on — an error the store still holds from an
 * earlier run is shown by the account's own marker, not by the line.
 */
export function lineSegments(state: LineState, order: string[], now: number): LineSegment[] {
  const entries = order.map((id) => [id, state[id]] as const).filter(([, e]) => e?.shown);
  const running = entries.filter(([, e]) => e.outcome === "running");
  const ended = entries.filter(([, e]) => e.ended !== null);
  const last = ended.reduce<LineEntry | null>((a, [, e]) => (!a || e.ended! > a.ended! ? e : a), null);
  // The run the line is showing started with its earliest runner, or, once
  // everything is over, with the account that finished last.
  const runStart = running.length > 0 ? Math.min(...running.map(([, e]) => e.since)) : last?.since ?? Infinity;
  const lit = running.length > 0 || (last !== null && now - last.ended! < LINGER_MS);
  const segments: LineSegment[] = [];
  for (const [accountId, e] of entries) {
    if (e.outcome === "running") segments.push({ accountId, percent: e.percent, state: "running" });
    else if (lit && e.ended! >= runStart) segments.push({ accountId, percent: e.outcome === "done" ? 100 : e.percent, state: e.outcome === "done" ? "fin" : "error" });
  }
  return segments;
}

export function lineChip(e: LineEntry | undefined, now: number): LineChip {
  if (!e || e.outcome !== "done" || e.ended === null || now - e.ended >= CHIP_MS) return null;
  if (e.newMails > 0) return { kind: "new", count: e.newMails };
  return e.shown ? { kind: "ok" } : null;
}

export function linePercent(e: LineEntry | undefined): number | null {
  return e?.percent ?? null;
}

/** The percentage next to the account, once the sync has run long enough to be worth reading. */
export function linePercentShown(e: LineEntry | undefined, now: number): number | null {
  if (!e || !e.shown || e.outcome !== "running" || e.percent === null || now - e.since < PERCENT_AFTER_MS) return null;
  return e.percent;
}

/** True once per run that ended with new mail: the cue for the light sweep over the title. */
export function finishedWithNewMail(prev: LineState, next: LineState): boolean {
  return Object.entries(next).some(([id, e]) => e.outcome === "done" && e.newMails > 0 && prev[id]?.outcome !== "done");
}

/** Milliseconds until the line next changes on its own, or null when it is at rest. */
export function nextDeadline(state: LineState, now: number): number | null {
  const waits: number[] = [];
  for (const e of Object.values(state)) {
    if (e.outcome === "running" && !e.shown) waits.push(e.since + REVEAL_MS - now);
    if (e.outcome === "running" && e.shown) waits.push(e.since + PERCENT_AFTER_MS - now);
    if (e.ended !== null) waits.push(e.ended + LINGER_MS - now, e.ended + CHIP_MS - now);
  }
  const ahead = waits.filter((w) => w > 0);
  return ahead.length > 0 ? Math.min(...ahead) : null;
}
