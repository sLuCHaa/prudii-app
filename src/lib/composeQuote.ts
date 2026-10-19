import i18n from "./i18n";
import { escapeHtml, parseBody } from "./sanitize";
import type { Mail } from "../types";

export interface QuoteMeta {
  fromName: string;
  fromEmail: string;
  date: string;
  subject?: string;
  to?: string;
}

type MailQuote = { kind: "reply" | "forward"; meta: QuoteMeta; body: string };

export type ComposeQuote =
  | MailQuote
  // A quote we cannot read back (legacy snapshot, rewritten by a server) is sent as it is.
  | { kind: "raw"; body: string };

const QUOTE_ATTR = "data-prudii-quote";

export const QUOTE_EDIT_ROOT = "prudii-quote-edit";

function formatDate(date: string): string {
  const d = new Date(date);
  return isNaN(d.getTime()) ? date || "" : d.toLocaleString();
}

function address(name: string, email: string): string {
  return name ? `${name} <${email}>` : email;
}

export function buildQuote(kind: "reply" | "forward", mail: Pick<Mail, "from" | "to" | "date" | "subject">, body: string): MailQuote {
  const meta: QuoteMeta = { fromName: mail.from.name || "", fromEmail: mail.from.email, date: mail.date };
  if (kind === "forward") {
    meta.subject = mail.subject;
    meta.to = mail.to.map((t) => address(t.name, t.email)).join(", ");
  }
  // Balanced tags: a stray </div> or </blockquote> in the mail would close the quote's wrapper.
  return { kind, meta, body: parseBody(body).innerHTML };
}

/** The quote as it leaves in the outgoing mail, marked so a reopened draft can find it again. */
export function renderQuote(quote: ComposeQuote): string {
  if (quote.kind === "raw") return quote.body;
  const { meta } = quote;
  const from = escapeHtml(address(meta.fromName, meta.fromEmail));
  const date = escapeHtml(formatDate(meta.date));
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

/** The outgoing body without our marker: drafts need it, recipients don't, and it would name the client. */
export function stripQuoteMarker(html: string): string {
  // renderQuote escapes the marker, so it never holds a raw double quote.
  return html.replace(/ data-prudii-quote="[^"]*"/g, "");
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function blankAfter(node: Node): boolean {
  for (let n = node.nextSibling; n; n = n.nextSibling) {
    if (n.textContent?.trim()) return false;
  }
  return true;
}

function readQuote(el: Element): ComposeQuote {
  const blockquote = el.lastElementChild;
  const wellFormed =
    blockquote?.tagName === "BLOCKQUOTE" &&
    blankAfter(blockquote) &&
    Array.from(el.children).slice(0, -1).every((c) => c.tagName === "P");
  try {
    const data = JSON.parse(el.getAttribute(QUOTE_ATTR) ?? "");
    if (wellFormed && (data.kind === "reply" || data.kind === "forward") && typeof data.fromEmail === "string") {
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
  // A marker inside a blockquote belongs to quoted history, ours or another client's.
  const candidates = Array.from(doc.querySelectorAll(`[${QUOTE_ATTR}]`)).filter((el) => !el.closest("blockquote"));
  const el = candidates[candidates.length - 1];
  if (!el) return { rest: html, quote: null };
  const quote = readQuote(el);
  el.remove();
  return { rest: doc.body.innerHTML, quote };
}

export function quoteFromHtml(html: string | undefined): ComposeQuote | null {
  if (!html) return null;
  return splitQuote(html).quote ?? { kind: "raw", body: html };
}

/** The editor part of a saved body whose quote is restored separately. */
export function bodyWithoutQuote(bodyHtml: string, quotedHtml: string | undefined): string {
  if (quotedHtml && bodyHtml.endsWith(quotedHtml)) return bodyHtml.slice(0, -quotedHtml.length);
  return splitQuote(bodyHtml).rest;
}
