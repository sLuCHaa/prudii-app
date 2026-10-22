import type { Mail } from "../types";

export function findBestFromAccount(
  originalMail: Mail,
  accounts: { id: string; email: string }[],
  fallbackAccountId: string,
): string {
  const accountByEmail = new Map<string, string>();
  for (const acc of accounts) {
    accountByEmail.set(acc.email.toLowerCase(), acc.id);
  }

  const allRecipients = [
    ...originalMail.to,
    ...originalMail.cc,
    ...originalMail.bcc,
  ];

  for (const addr of allRecipients) {
    const match = accountByEmail.get(addr.email.toLowerCase());
    if (match) return match;
  }

  if (accounts.find((a) => a.id === originalMail.account_id)) {
    return originalMail.account_id;
  }

  return fallbackAccountId;
}
