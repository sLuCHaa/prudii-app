export type LinkProblem = "spaces" | "scheme" | "domain" | "email" | "phone";

export type LinkInput = { ok: true; href: string } | { ok: false; reason: LinkProblem | "empty" };

const EMAIL = /^[^\s@/:]+@[^\s@/]+\.[^\s@/.]{2,}$/;

/** Turns what the user typed into a link target, or names why it is not one. */
export function normalizeLinkInput(raw: string): LinkInput {
  const text = raw.trim();
  if (!text) return { ok: false, reason: "empty" };
  const lower = text.toLowerCase();

  if (lower.startsWith("tel:")) {
    const digits = text.slice(4).replace(/[\s\-()/.]/g, "");
    return /^\+?\d{3,}$/.test(digits) ? { ok: true, href: `tel:${digits}` } : { ok: false, reason: "phone" };
  }
  if (/\s/.test(text)) return { ok: false, reason: "spaces" };
  if (lower.startsWith("mailto:")) {
    return EMAIL.test(text.slice(7).split("?")[0]) ? { ok: true, href: text } : { ok: false, reason: "email" };
  }

  // A colon followed by a digit is a port ("firma.de:8080"), not a scheme.
  const scheme = /^([a-z][a-z0-9+.-]*):(?!\d)/i.exec(text);
  if (scheme && !/^https?$/i.test(scheme[1])) return { ok: false, reason: "scheme" };
  if (!scheme && EMAIL.test(text)) return { ok: true, href: `mailto:${text}` };

  const href = scheme ? text : `https://${text}`;
  let host: string;
  try {
    host = new URL(href).hostname;
  } catch {
    return { ok: false, reason: "domain" };
  }
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith("[");
  if (!isIp && !/\.[a-z0-9-]{2,}$/i.test(host)) return { ok: false, reason: "domain" };
  return { ok: true, href };
}
