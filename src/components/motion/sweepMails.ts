// Row-exit motion for the mail list. The folder-empty sweep cascades every
// visible row away before the refetch clears them; single removals reuse the
// same tween so one mail leaving looks like one row of that cascade.
// A DOM event keeps sidebar and list decoupled; `handled` reports back
// synchronously whether a list claimed the sweep (so the caller knows to wait
// before invalidating).

export const SWEEP_MAILS_EVENT = "prudii:sweep-mails";

/** Covers the tween plus the capped stagger window in the listener. */
export const SWEEP_DURATION_MS = 430;

/** The exit tween itself — shared so both paths stay in sync. */
export const SWEEP_TWEEN = {
  x: -90,
  opacity: 0,
  rotate: -1.5,
  duration: 0.28,
  ease: "power2.in",
} as const;

export interface SweepDetail {
  folderId: string;
  handled: boolean;
}

export function requestMailSweep(folderId: string): boolean {
  const detail: SweepDetail = { folderId, handled: false };
  window.dispatchEvent(new CustomEvent(SWEEP_MAILS_EVENT, { detail }));
  return detail.handled;
}
