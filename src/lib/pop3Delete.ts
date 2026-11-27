import type { TFunction } from "i18next";
import { countPop3ServerDeletes } from "./tauri";
import { useAppStore } from "../stores/appStore";

type Question = { title: string; message: string; confirmLabel?: string; cancelLabel?: string };

let asking = false;

export const isAskingServerDelete = () => asking;

export function deletesOnPop3Server(accountId?: string): boolean {
  return useAppStore
    .getState()
    .accounts.some((a) => (!accountId || a.id === accountId) && a.incoming_protocol === "pop3" && a.pop3_delete_with_local);
}

/** For folder-wide deletes; without an account id any account counts. */
export function withServerDeleteWarning(t: TFunction, message: string, scope: "folder" | "combined", accountId?: string): string {
  return deletesOnPop3Server(accountId) ? `${message} ${t(`pop3.deleteWarning.${scope}`)}` : message;
}

/** Asks when these mails would also leave a POP3 server, or when `base` is a question of its own. */
export async function confirmMailDelete(
  danger: (question: Question) => Promise<boolean>,
  t: TFunction,
  mailIds: string[],
  base?: Question,
): Promise<boolean> {
  // A failed check warns rather than deleting unasked.
  const count = deletesOnPop3Server() ? await countPop3ServerDeletes(mailIds).catch(() => mailIds.length) : 0;
  if (count === 0) return base ? danger(base) : true;
  if (asking) return false;
  asking = true;
  try {
    const warning = t("pop3.deleteWarning.mails", { count });
    return await danger(
      base
        ? { ...base, message: `${base.message} ${warning}` }
        : { title: t("pop3.deleteWarning.title"), message: warning, confirmLabel: t("common.delete"), cancelLabel: t("common.cancel") },
    );
  } finally {
    // The key press that closes the dialog still reaches the window listeners.
    setTimeout(() => { asking = false; });
  }
}
