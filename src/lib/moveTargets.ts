import type { Account, Folder } from "../types";

/**
 * The folders a mail may be moved into.
 *
 * `folders` must be the folders of the mail's *own* account: an all-inboxes or
 * combined view lists mails from several accounts at once, and each account has
 * its own mailboxes. Passing the open account's folders there would offer
 * destinations the mail cannot reach.
 *
 * The mail's current folder drops out (moving it there is a no-op), and so do
 * drafts, which are written rather than filed. `sourceFolderId` is null when the
 * source is not a single known folder — nothing is hidden then.
 */
export function moveTargets(folders: Folder[], sourceFolderId: string | null): Folder[] {
  return folders.filter((f) => f.id !== sourceFolderId && f.folder_type !== "drafts");
}

export interface CopyGroup {
  account: Account;
  folders: Folder[];
}

type CopyAccount = Pick<Account, "provider" | "auth_type" | "incoming_protocol">;

/** A copy is filed locally for POP3 and uploaded over IMAP otherwise; Google and Microsoft sign-ins file through their own API. */
export function accountTakesCopy(account: CopyAccount): boolean {
  if (account.incoming_protocol === "pop3") return true;
  return !(account.auth_type === "oauth" && (account.provider === "google" || account.provider === "microsoft"));
}

/** Except for POP3 a copy needs a folder on the server; drafts are written, not filed. */
export function takesCopy(account: CopyAccount, folder: Folder): boolean {
  if (folder.folder_type === "drafts") return false;
  return accountTakesCopy(account) && (account.incoming_protocol === "pop3" || !folder.is_local);
}

/** The folders of other accounts a mail can be copied into. */
export function copyTargets(accounts: Account[], sourceAccountId: string | null, foldersOf: (accountId: string) => Folder[]): CopyGroup[] {
  if (!sourceAccountId) return [];
  return accounts
    .filter((a) => a.id !== sourceAccountId)
    .map((account) => ({ account, folders: foldersOf(account.id).filter((f) => takesCopy(account, f)) }))
    .filter((group) => group.folders.length > 0);
}

const plain = (text: string) => text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();

/** `labelOf` is the name as displayed: standard folders are shown translated, not by their server name. */
export function matchFolders(folders: Folder[], typed: string, labelOf: (folder: Folder) => string): Folder[] {
  const needle = plain(typed.trim());
  if (!needle) return folders;
  return folders.filter((f) => plain(labelOf(f)).includes(needle));
}
