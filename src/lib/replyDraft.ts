import type { MailAddress } from "../types";

/** Format a MailAddress as a recipient chip string, handling missing/invalid emails */
export function formatAddress(addr: MailAddress): string | null {
  const emailLike = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (addr.email && emailLike.test(addr.email)) {
    // Only use display name if it's a clean phrase — names containing '@' or '<>'
    // produce RFC 5322 parse failures and break the send pipeline.
    const cleanName = addr.name?.trim() ?? "";
    const nameUsable = cleanName && !cleanName.includes("@") && !cleanName.includes("<") && !cleanName.includes(">");
    return nameUsable ? `${cleanName} <${addr.email}>` : addr.email;
  }
  // email field is missing/invalid — check if the name contains a valid email
  if (addr.name && emailLike.test(addr.name)) {
    return addr.name;
  }
  return null;
}

export function replyRecipientDraft(target: MailAddress): string | null {
  if (formatAddress(target) !== null) return null;
  return target.name?.trim() || null;
}
