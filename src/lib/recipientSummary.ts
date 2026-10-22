import type { MailAddress } from "../types";

export interface RecipientSummary {
  first: string;
  more: number;
}

export function recipientSummary(to: MailAddress[], cc: MailAddress[]): RecipientSummary | null {
  const lead = to[0] ?? cc[0];
  if (!lead) return null;
  return { first: lead.name || lead.email, more: to.length + cc.length - 1 };
}
