export interface FocusSyncState {
  blurredAt: number | null;
}

export const INITIAL_FOCUS_SYNC_STATE: FocusSyncState = { blurredAt: null };

// A sync on every Alt-Tab would spawn sync_all_accounts tasks that the
// per-account lock immediately reports as "skipped"; only a real absence counts.
export function focusSyncStep(
  state: FocusSyncState,
  focused: boolean,
  now: number,
  minAwayMs: number,
): { state: FocusSyncState; sync: boolean } {
  if (!focused) {
    return { state: { blurredAt: state.blurredAt ?? now }, sync: false };
  }
  const away = state.blurredAt === null ? 0 : now - state.blurredAt;
  return { state: { blurredAt: null }, sync: state.blurredAt !== null && away >= minAwayMs };
}
