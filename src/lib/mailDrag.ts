// Shared by every mail drop target (sidebar folders, the tasks entry, task
// cards, the task drawer) so the payload contract lives in exactly one place.

export interface MailDragPayload {
  mailId: string;
  accountId: string;
}

export function isMailDrag(dt: DataTransfer): boolean {
  return dt.types.includes("application/x-mail-id");
}

export function readMailDrag(dt: DataTransfer): MailDragPayload | null {
  const mailId = dt.getData("application/x-mail-id");
  if (!mailId) return null;
  const accountId = dt.getData("application/x-mail-account-id");
  return { mailId, accountId };
}
