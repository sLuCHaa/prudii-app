// The big providers, where most typos happen; a fresh contact list does not know them yet.
const PROVIDERS = [
  "gmail.com", "googlemail.com", "gmx.de", "gmx.net", "gmx.at", "gmx.ch", "gmx.com", "web.de", "t-online.de",
  "freenet.de", "arcor.de", "posteo.de", "mailbox.org", "mail.de", "outlook.com", "outlook.de", "hotmail.com",
  "hotmail.de", "live.com", "live.de", "msn.com", "yahoo.com", "yahoo.de", "icloud.com", "me.com", "mac.com",
  "aol.com", "proton.me", "protonmail.com",
];

// Real endings of three letters or more. Two-letter endings are country codes and always count as real,
// so gmx.at or roboforex.ru are never "corrected".
const REAL_TLDS = new Set([
  "com", "net", "org", "info", "biz", "app", "dev", "edu", "gov", "xyz", "online", "shop", "site", "email",
  "tech", "cloud", "store", "pro", "live", "blog", "news", "club", "gmbh", "berlin", "bayern", "swiss", "wien",
]);

export interface KnownDomains {
  /** Every domain already written to or received from; these are never flagged. */
  known: Set<string>;
  /** Domains a typo is checked against, besides the big providers. */
  candidates: string[];
}

function splitDomain(domain: string): [string, string] {
  const dot = domain.lastIndexOf(".");
  return dot <= 0 ? ["", ""] : [domain.slice(0, dot), domain.slice(dot + 1)];
}

// Edit distance that counts two swapped neighbours as one typo (gmial → gmail).
function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

function isSwap(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const i = [...a].findIndex((ch, k) => ch !== b[k]);
  return i >= 0 && a[i] === b[i + 1] && a[i + 1] === b[i] && a.slice(i + 2) === b.slice(i + 2);
}

// Subdomains of one organisation (relay01/relay02.netcup.net, e.klarna.com) are real siblings, not typos.
const parentOf = (domain: string) => domain.split(".").slice(-2).join(".");

function isTypoOf(typed: string, candidate: string): boolean {
  const [name, tld] = splitDomain(typed);
  const [candidateName, candidateTld] = splitDomain(candidate);
  if (tld !== candidateTld) {
    return name === candidateName && tld.length >= 3 && !REAL_TLDS.has(tld) && editDistance(tld, candidateTld) === 1;
  }
  if (name.split(".").length !== candidateName.split(".").length || parentOf(typed) === parentOf(candidate)) return false;
  // In very short names a changed letter is usually a different domain (esn.com, msn.com); a swap is not.
  if (candidateName.length < 4) return isSwap(name, candidateName);
  return editDistance(name, candidateName) === 1;
}

/** The known domain the user most likely meant: one slip away and unambiguous, never a domain already in use. */
export function suggestDomain(domain: string, { known, candidates }: KnownDomains): string | null {
  const typed = domain.toLowerCase();
  if (!splitDomain(typed)[0] || known.has(typed) || PROVIDERS.includes(typed)) return null;
  const matches = [...new Set([...PROVIDERS, ...candidates])].filter((candidate) => isTypoOf(typed, candidate));
  return matches.length === 1 ? matches[0] : null;
}

export function domainOf(chip: string): string {
  const email = (chip.match(/<([^>]+)>/)?.[1] ?? chip).trim();
  const at = email.lastIndexOf("@");
  return at < 0 ? "" : email.slice(at + 1).toLowerCase();
}

export function withDomain(chip: string, domain: string): string {
  return chip.replace(/@[^@\s<>]+(?=>?\s*$)/, `@${domain}`);
}
