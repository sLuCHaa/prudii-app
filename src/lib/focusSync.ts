export interface FocusSyncState {
  blurredAt: number | null;
}

export const INITIAL_FOCUS_SYNC_STATE: FocusSyncState = { blurredAt: null };

// A sync on every Alt-Tab would spawn sync_all_accounts tasks that the
// per-account lock immediately reports as "skipped"; only a real absence counts.
// `internalBlur` marks focus moving to one of our own windows (compose, backup):
// that is not an absence, so returning from it must not trigger a sync.
export function focusSyncStep(
  state: FocusSyncState,
  focused: boolean,
  now: number,
  minAwayMs: number,
  internalBlur = false,
): { state: FocusSyncState; sync: boolean } {
  if (!focused) {
    if (internalBlur) return { state, sync: false };
    return { state: { blurredAt: state.blurredAt ?? now }, sync: false };
  }
  const away = state.blurredAt === null ? 0 : now - state.blurredAt;
  return { state: { blurredAt: null }, sync: state.blurredAt !== null && away >= minAwayMs };
}
