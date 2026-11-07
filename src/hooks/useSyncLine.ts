import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { useAppStore } from "../stores/appStore";
import { advanceLine, finishedWithNewMail, nextDeadline, type LineState } from "../lib/syncLine";

export interface SyncLine {
  state: LineState;
  now: number;
  /** Bumps once per sync that brought new mail. */
  sweepKey: number;
  /** A sync the user asked for shows at once instead of after the push threshold. */
  revealNext: () => void;
}

// Long enough to catch the first progress event of a sync the user just started.
const MANUAL_WINDOW_MS = 4000;

/** One instance per sidebar; children read it through SyncLineContext. */
export function useSyncLineSource(): SyncLine {
  const progress = useAppStore((s) => s.syncProgress);
  const [line, setLine] = useState<{ state: LineState; now: number; sweepKey: number }>({ state: {}, now: 0, sweepKey: 0 });
  const stateRef = useRef<LineState>({});
  const manualUntil = useRef(0);

  const advance = useCallback(() => {
    const now = performance.now();
    const prev = stateRef.current;
    const next = advanceLine(prev, useAppStore.getState().syncProgress, now, now < manualUntil.current);
    stateRef.current = next;
    const swept = finishedWithNewMail(prev, next);
    setLine((l) => ({ state: next, now, sweepKey: l.sweepKey + (swept ? 1 : 0) }));
  }, []);

  useEffect(() => {
    advance();
  }, [progress, advance]);

  // Reveal, linger and chip all end on their own, without a store event.
  useEffect(() => {
    const wait = nextDeadline(line.state, line.now);
    if (wait === null) return;
    const id = window.setTimeout(advance, wait + 16);
    return () => window.clearTimeout(id);
  }, [line, advance]);

  const revealNext = useCallback(() => {
    manualUntil.current = performance.now() + MANUAL_WINDOW_MS;
    advance();
  }, [advance]);

  return { ...line, revealNext };
}

export const SyncLineContext = createContext<SyncLine | null>(null);

const IDLE_LINE: SyncLine = { state: {}, now: 0, sweepKey: 0, revealNext: () => {} };

export function useSyncLine(): SyncLine {
  return useContext(SyncLineContext) ?? IDLE_LINE;
}
