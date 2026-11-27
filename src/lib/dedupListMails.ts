import type { Mail } from "../types";

// POP3 twins are separate local mails, so only a copy seen through another account folds for them.
export function dedupListMails(mails: Mail[], pop3AccountIds: ReadonlySet<string>): Mail[] {
  const seenIds = new Set<string>();
  const contentOwner = new Map<string, string>();
  return mails.filter((m) => {
    const pop3 = pop3AccountIds.has(m.account_id);
    const idKey = (!pop3 && m.message_id) || m.id;
    if (seenIds.has(idKey)) return false;
    seenIds.add(idKey);
    const contentKey = `${m.subject.toLowerCase().trim()}|${m.date}|${m.from.email.toLowerCase()}`;
    const owner = contentOwner.get(contentKey);
    if (owner === undefined) {
      contentOwner.set(contentKey, m.account_id);
      return true;
    }
    return pop3 && owner === m.account_id;
  });
}
