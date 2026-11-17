import type { UndoSendState } from "../stores/appStore";
import type { SendMailRequest } from "../types";

export interface UndoSendStep {
  /** A mail still in its undo window that a newer send displaces: it goes out now instead of being dropped. */
  flush: UndoSendState | null;
  countdown: "start" | "resume" | "none";
}

/**
 * pending: the mail whose countdown runs but which has not been handed to the server yet.
 * lastRequest: the request the last countdown was started for.
 */
export function undoSendStep(pending: UndoSendState | null, lastRequest: SendMailRequest | null, next: UndoSendState): UndoSendStep {
  if (!next.active || !next.request) return { flush: null, countdown: "none" };
  if (next.request === lastRequest) return { flush: null, countdown: pending ? "resume" : "none" };
  return { flush: pending && pending.request !== next.request ? pending : null, countdown: "start" };
}
