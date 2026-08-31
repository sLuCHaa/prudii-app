// Folder-empty sweep: the sidebar asks, the visible mail list animates its
// rows away before the refetch clears them. A DOM event keeps the two
// components decoupled; `handled` reports back synchronously whether a list
// claimed the sweep (so the caller knows to wait before invalidating).

export const SWEEP_MAILS_EVENT = "prudii:sweep-mails";

/** Covers the tween plus the capped stagger window in the listener. */
export const SWEEP_DURATION_MS = 430;

export interface SweepDetail {
  folderId: string;
  handled: boolean;
}

export function requestMailSweep(folderId: string): boolean {
  const detail: SweepDetail = { folderId, handled: false };
  window.dispatchEvent(new CustomEvent(SWEEP_MAILS_EVENT, { detail }));
  return detail.handled;
}
