import type { Folder, Mail } from "../types";

const OUTGOING_TYPES = new Set(["sent", "drafts"]);

export function makeIsOutgoing(folders: Folder[], ownEmails: string[], combinedFolderType: string | null): (mail: Mail) => boolean {
  if (combinedFolderType && OUTGOING_TYPES.has(combinedFolderType)) return () => true;
  const outgoingFolders = new Set(folders.filter((f) => OUTGOING_TYPES.has(f.folder_type)).map((f) => f.id));
  const own = new Set(ownEmails.map((e) => e.toLowerCase()));
  return (mail) => outgoingFolders.has(mail.folder_id) || own.has(mail.from.email.toLowerCase());
}
