import type { Contact, Mail } from "../types";
import type { EmbeddedMail } from "./embeddedMails";
import { FORWARD_SUBJECT } from "./quotedHistory";

const SUBJECT_PREFIX = /^\s*(?:(?:re|aw|fwd?|wg)\s*:\s*)+/i;

export function embeddedMailToMail(outer: Mail, part: EmbeddedMail): Mail {
  return {
    id: outer.id,
    account_id: outer.account_id,
    folder_id: outer.folder_id,
    has_attachments: outer.has_attachments,
    flags: outer.flags,
    uid: null,
    size_bytes: null,
    list_unsubscribe: null,
    snoozed_until: null,
    from: part.from,
    to: part.to,
    cc: part.cc,
    date: part.date,
    bcc: [],
    reply_to: [],
    message_id: "",
    in_reply_to: null,
    references: "",
    thread_id: null,
    subject: part.subject || outer.subject.replace(SUBJECT_PREFIX, ""),
    body_html: part.quote(),
    body_text: "",
    snippet: part.preview,
    is_read: false,
    is_starred: false,
    is_flagged: false,
    is_replied: false,
    is_forwarded: false,
    is_pinned: false,
  };
}

export async function resolveNameOnlySender(mail: Mail, search: (query: string) => Promise<Contact[]>): Promise<Mail> {
  const name = mail.from.name.trim();
  if (mail.from.email || !name) return mail;
  const matches = (await search(mail.from.name)).filter((c) => c.name.trim().toLowerCase() === name.toLowerCase());
  if (matches.length !== 1) return mail;
  return { ...mail, from: { name: mail.from.name, email: matches[0].email } };
}

export function cardBadge(parts: EmbeddedMail[], index: number): "original" | "forwarded" | null {
  if (index === parts.length - 1) return "original";
  return FORWARD_SUBJECT.test(parts[index].subject) ? "forwarded" : null;
}

export function initiallyOpen(count: number): boolean[] {
  return Array.from({ length: count }, (_, i) => count <= 2 || i === count - 1);
}
