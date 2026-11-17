import type { ComposeInitData } from "./ComposeModal";
import type { MailtoParams } from "../../lib/mailtoParser";

export interface ComposeInputs {
  selectedAccountId: string | null;
  mailtoParams: MailtoParams | null;
  aiReplyText: string | null;
}

/** A form opened with its own data keeps it: the docked form shares the main window's store, which changes with every later compose or click. */
export function composeInputs(initData: ComposeInitData | null | undefined, store: ComposeInputs): ComposeInputs {
  if (!initData) return store;
  return {
    selectedAccountId: initData.selectedAccountId,
    mailtoParams: initData.mailtoParams ?? null,
    aiReplyText: initData.aiReplyText ?? null,
  };
}
