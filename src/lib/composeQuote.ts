import i18n from "./i18n";
import { escapeHtml } from "./sanitize";

export interface QuoteMeta {
  fromName: string;
  fromEmail: string;
  date: string;
  subject?: string;
  to?: string;
}

export type ComposeQuote =
  | { kind: "reply" | "forward"; meta: QuoteMeta; body: string }
  // A quote we cannot read back (legacy snapshot, rewritten by a server) is sent as it is.
  | { kind: "raw"; body: string };

const QUOTE_ATTR = "data-prudii-quote";

export const QUOTE_EDIT_ROOT = "prudii-quote-edit";

export function formatQuoteDate(date: string): string {
  const d = new Date(date);
  return isNaN(d.getTime()) ? date || "" : d.toLocaleString();
}

function address(name: string, email: string): string {
  return name ? `${name} <${email}>` : email;
}

/** The quote as it leaves in the outgoing mail, marked so a reopened draft can find it again. */
export function renderQuote(quote: ComposeQuote): string {
  if (quote.kind === "raw") return quote.body;
  const { meta } = quote;
  const from = escapeHtml(address(meta.fromName, meta.fromEmail));
  const date = escapeHtml(formatQuoteDate(meta.date));
  const header =
    quote.kind === "reply"
      ? `<p>${i18n.t("compose.replyIntro", { date, from })}</p>`
      : `<p>${i18n.t("compose.forwardHeaderTitle")}</p>` +
        `<p><strong>${i18n.t("compose.forwardHeaderFrom")}</strong> ${from}</p>` +
        `<p><strong>${i18n.t("compose.forwardHeaderDate")}</strong> ${date}</p>` +
        `<p><strong>${i18n.t("compose.forwardHeaderSubject")}</strong> ${escapeHtml(meta.subject ?? "")}</p>` +
        `<p><strong>${i18n.t("compose.forwardHeaderTo")}</strong> ${escapeHtml(meta.to ?? "")}</p>`;
  const marker = escapeHtml(JSON.stringify({ kind: quote.kind, ...meta }));
  return `<div ${QUOTE_ATTR}="${marker}">${header}<blockquote>${quote.body}</blockquote></div>`;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readQuote(el: Element): ComposeQuote {
  const blockquote = Array.from(el.children).reverse().find((c) => c.tagName === "BLOCKQUOTE");
  try {
    const data = JSON.parse(el.getAttribute(QUOTE_ATTR) ?? "");
    if (blockquote && (data.kind === "reply" || data.kind === "forward") && typeof data.fromEmail === "string") {
      const meta: QuoteMeta = { fromName: text(data.fromName), fromEmail: data.fromEmail, date: text(data.date) };
      if (data.kind === "forward") {
        meta.subject = text(data.subject);
        meta.to = text(data.to);
      }
      return { kind: data.kind, meta, body: blockquote.innerHTML };
    }
  } catch { /* unreadable marker */ }
  return { kind: "raw", body: el.outerHTML };
}

/** Separate a stored body into its own text and the quote it ends with. */
export function splitQuote(html: string): { rest: string; quote: ComposeQuote | null } {
  if (!html.includes(QUOTE_ATTR)) return { rest: html, quote: null };
  const doc = new DOMParser().parseFromString(html, "text/html");
  const outermost = Array.from(doc.querySelectorAll(`[${QUOTE_ATTR}]`)).filter(
    (el) => !el.parentElement?.closest(`[${QUOTE_ATTR}]`),
  );
  const el = outermost[outermost.length - 1];
  if (!el) return { rest: html, quote: null };
  const quote = readQuote(el);
  el.remove();
  return { rest: doc.body.innerHTML, quote };
}

export function quoteFromHtml(html: string | undefined): ComposeQuote | null {
  if (!html) return null;
  return splitQuote(html).quote ?? { kind: "raw", body: html };
}
