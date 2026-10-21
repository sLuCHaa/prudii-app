function splitAddressList(input: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && ch === "<") {
      inAngle = true;
    } else if (!inQuotes && ch === ">") {
      inAngle = false;
    } else if (ch === "," && !inQuotes && !inAngle) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);

  const recipients: string[] = [];
  let pending: string[] = [];
  for (const segment of segments) {
    pending.push(segment);
    if (segment.includes("@")) {
      recipients.push(pending.join(",").trim());
      pending = [];
    }
  }
  if (pending.join(",").trim()) {
    recipients.push(pending.join(",").trim());
  }
  return recipients.filter(Boolean);
}

function parseRecipients(input: string): { email: string; name?: string }[] {
  if (!input.trim()) return [];
  return splitAddressList(input).map((trimmed) => {
    const match = trimmed.match(/^(.+?)\s*<(.+?)>$/);
    if (match) {
      return { name: match[1].trim().replace(/^"|"$/g, "").trim(), email: match[2].trim() };
    }
    return { email: trimmed };
  });
}

export type SendBlocker =
  | { key: "compose.enterRecipient" }
  | { key: "compose.selectAccount" }
  | { key: "compose.invalidEmail"; email: string };

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Stops a mail before anything is asked, the same for sending now and scheduling. */
export function sendBlocker(to: string[], cc: string[], bcc: string[], hasAccount: boolean): SendBlocker | null {
  if (to.length === 0) return { key: "compose.enterRecipient" };
  if (!hasAccount) return { key: "compose.selectAccount" };
  for (const chip of [...to, ...cc, ...bcc]) {
    const invalid = parseRecipients(chip).find((r) => !EMAIL.test(r.email));
    if (invalid) return { key: "compose.invalidEmail", email: invalid.email };
  }
  return null;
}

export const MANY_RECIPIENTS = 10;

export function countRecipients(to: string[], cc: string[], bcc: string[]): number {
  return [...to, ...cc, ...bcc].reduce((n, chip) => n + parseRecipients(chip).length, 0);
}
