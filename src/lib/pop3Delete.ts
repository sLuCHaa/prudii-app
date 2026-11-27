import type { TFunction } from "i18next";
import { countPop3ServerDeletes } from "./tauri";
import { useAppStore } from "../stores/appStore";

type Question = { title: string; message: string; confirmLabel?: string; cancelLabel?: string };

export type GuardedMail = { id: string; account_id?: string };

let asking = false;
const inFlight = new Set<string>();

export const isAskingServerDelete = () => asking;

export function deletesOnPop3Server(accountId?: string): boolean {
  return useAppStore
    .getState()
    .accounts.some((a) => (!accountId || a.id === accountId) && a.incoming_protocol === "pop3" && a.pop3_delete_with_local);
}

/** A mail whose account is unknown counts as affected as soon as any account is. */
export function mayDeleteOnPop3Server(mails: GuardedMail[]): boolean {
  const { accounts } = useAppStore.getState();
  return deletesOnPop3Server() && mails.some(
    ({ account_id }) => !accounts.some((a) => a.id === account_id) || deletesOnPop3Server(account_id),
  );
}

/** A repeated trigger would find the mail already in the trash and purge it unasked. */
export async function withDeleteLock(mails: GuardedMail[], task: () => Promise<unknown>): Promise<void> {
  if (mails.some((m) => inFlight.has(m.id))) return;
  mails.forEach((m) => inFlight.add(m.id));
  try {
    await task();
  } finally {
    mails.forEach((m) => inFlight.delete(m.id));
  }
}

/** For folder-wide deletes; without an account id any account counts. */
export function withServerDeleteWarning(t: TFunction, message: string, scope: "folder" | "combined", accountId?: string): string {
  return deletesOnPop3Server(accountId) ? `${message} ${t(`pop3.deleteWarning.${scope}`)}` : message;
}

/** Asks when these mails would also leave a POP3 server, or when `base` is a question of its own. */
export async function confirmMailDelete(
  danger: (question: Question) => Promise<boolean>,
  t: TFunction,
  mails: GuardedMail[],
  base?: Question,
): Promise<boolean> {
  // A failed check warns rather than deleting unasked.
  const ids = mails.map((m) => m.id);
  const count = mayDeleteOnPop3Server(mails) ? await countPop3ServerDeletes(ids).catch(() => ids.length) : 0;
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
