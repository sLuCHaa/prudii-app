import type { Folder } from "../types";

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
