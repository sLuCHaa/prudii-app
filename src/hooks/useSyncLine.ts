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

/** One instance per sidebar; children read it through SyncLineContext. */
export function useSyncLineSource(): SyncLine {
  const progress = useAppStore((s) => s.syncProgress);
  const [line, setLine] = useState<{ state: LineState; now: number; sweepKey: number }>({ state: {}, now: 0, sweepKey: 0 });
  const stateRef = useRef<LineState>({});

  const advance = useCallback(() => {
    const now = performance.now();
    const prev = stateRef.current;
    const { syncProgress, syncRevealUntil } = useAppStore.getState();
    const next = advanceLine(prev, syncProgress, now, now < syncRevealUntil);
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
    useAppStore.getState().revealSyncLine();
    advance();
  }, [advance]);

  return { ...line, revealNext };
}

export const SyncLineContext = createContext<SyncLine | null>(null);

const IDLE_LINE: SyncLine = { state: {}, now: 0, sweepKey: 0, revealNext: () => {} };

export function useSyncLine(): SyncLine {
  return useContext(SyncLineContext) ?? IDLE_LINE;
}
