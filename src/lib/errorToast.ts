import i18n from "./i18n";
import { useAppStore } from "../stores/appStore";

export type ErrorCause = "network" | "auth" | "server";

/**
 * Best-effort cause detection from a stringified Tauri/JS error.
 * Returns undefined if no known pattern matches.
 */
export function detectCause(err: unknown): ErrorCause | undefined {
  const msg = String(err ?? "").toLowerCase();
  if (/network|timeout|connection|offline|dns|econn/.test(msg)) return "network";
  if (/401|unauthor|invalid_grant|expired|forbidden|403/.test(msg)) return "auth";
  if (/500|502|503|504|server error/.test(msg)) return "server";
  return undefined;
}

/**
 * Surface an async failure to the user as an error toast.
 * - Always logs to console.error with the action key for grep-ability.
 * - Shows toast title from the i18n key, optional cause line as toast message.
 *
 * @param err the caught error (any shape)
 * @param actionKey i18n key for the toast title, e.g. "errors.archive"
 * @param cause optional explicit cause; if omitted, detectCause is run on err
 */
export function toastError(err: unknown, actionKey: string, cause?: ErrorCause): void {
  console.error(`[${actionKey}]`, err);
  const resolved = cause ?? detectCause(err);
  const causeMsg = resolved ? i18n.t(`errors.cause.${resolved}`) : undefined;
  useAppStore.getState().addToast("error", i18n.t(actionKey), causeMsg);
}

export interface RunMailActionOpts {
  /** i18n key for the error toast title, e.g. "errors.archive". */
  errorKey: string;
  /** Called on both success and failure to refresh the mail-related React Query cache. */
  invalidate?: () => void;
  /** Called only on failure, to clear local optimistic state (e.g. setPendingRemoveId(null)). */
  onPendingClear?: () => void;
  /** Called only on success, after invalidate. */
  onSuccess?: () => void;
}

/**
 * Run a user-initiated mail mutation with consistent error handling.
 *
 * On success: invalidate is called (cache refetches truth), then onSuccess.
 * On failure: onPendingClear, then invalidate, then error toast. Never re-throws.
 */
export function runMailAction<T>(
  fn: () => Promise<T>,
  opts: RunMailActionOpts,
): Promise<T | void> {
  return fn()
    .then((r) => {
      opts.invalidate?.();
      opts.onSuccess?.();
      return r;
    })
    .catch((e) => {
      opts.onPendingClear?.();
      opts.invalidate?.();
      toastError(e, opts.errorKey);
    });
}
