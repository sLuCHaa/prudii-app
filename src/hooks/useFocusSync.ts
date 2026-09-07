import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { focusSyncStep, INITIAL_FOCUS_SYNC_STATE, type FocusSyncState } from "../lib/focusSync";

const DEFAULT_MIN_AWAY_MS = 60_000;

export function useFocusSync(onSync: () => void, minAwayMs = DEFAULT_MIN_AWAY_MS): void {
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;
  const stateRef = useRef<FocusSyncState>(INITIAL_FOCUS_SYNC_STATE);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        const next = focusSyncStep(stateRef.current, focused, Date.now(), minAwayMs);
        stateRef.current = next.state;
        if (next.sync) onSyncRef.current();
      })
      .then((fn) => {
        if (cancelled) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [minAwayMs]);
}
