import { useEffect, useRef } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import { focusSyncStep, INITIAL_FOCUS_SYNC_STATE, type FocusSyncState } from "../lib/focusSync";

const DEFAULT_MIN_AWAY_MS = 60_000;
const OWN_WINDOW_PREFIXES = ["compose-", "backup"];

// Blur while one of our own windows is open most likely means focus went there,
// not to another app — writing a mail must not count as being away.
async function blurredToOwnWindow(): Promise<boolean> {
  try {
    const windows = await getAllWebviewWindows();
    return windows.some((w) => OWN_WINDOW_PREFIXES.some((prefix) => w.label.startsWith(prefix)));
  } catch {
    return false;
  }
}

export function useFocusSync(onSync: () => void, minAwayMs = DEFAULT_MIN_AWAY_MS): void {
  const onSyncRef = useRef(onSync);
  onSyncRef.current = onSync;
  const stateRef = useRef<FocusSyncState>(INITIAL_FOCUS_SYNC_STATE);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    let latest = 0;
    getCurrentWindow()
      .onFocusChanged(({ payload: focused }) => {
        const at = Date.now();
        const ticket = ++latest;
        const internalBlur = focused ? Promise.resolve(false) : blurredToOwnWindow();
        internalBlur
          .then((internal) => {
            // The window list is fetched async — a newer focus event owns the
            // state by then, so a late answer must not overwrite it.
            if (cancelled || ticket !== latest) return;
            const next = focusSyncStep(stateRef.current, focused, at, minAwayMs, internal);
            stateRef.current = next.state;
            if (next.sync) onSyncRef.current();
          })
          .catch(() => {});
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
