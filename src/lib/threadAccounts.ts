import type { Account, Mail } from "../types";

/** The account a thread card lies in, when that is not the account of the mail the user opened. */
export function otherAccount(mail: Pick<Mail, "account_id">, openedAccountId: string, accounts: Account[]): Account | null {
  if (mail.account_id === openedAccountId) return null;
  return accounts.find((a) => a.id === mail.account_id) ?? null;
}
