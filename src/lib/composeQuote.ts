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

type MailQuote = {
  kind: "reply" | "forward";
  meta: QuoteMeta;
  body: string;
  /** Only once the user changed the sender line; "" when they deleted it. */
  header?: string;
};

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
  if (!email) return name;
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

function generatedHeader(quote: MailQuote): string {
  const { meta } = quote;
  const from = escapeHtml(address(meta.fromName, meta.fromEmail));
  const date = escapeHtml(formatDate(meta.date));
  return quote.kind === "reply"
    ? `<p>${i18n.t("compose.replyIntro", { date, from })}</p>`
    : `<p>${i18n.t("compose.forwardHeaderTitle")}</p>` +
        `<p><strong>${i18n.t("compose.forwardHeaderFrom")}</strong> ${from}</p>` +
        `<p><strong>${i18n.t("compose.forwardHeaderDate")}</strong> ${date}</p>` +
        `<p><strong>${i18n.t("compose.forwardHeaderSubject")}</strong> ${escapeHtml(meta.subject ?? "")}</p>` +
        `<p><strong>${i18n.t("compose.forwardHeaderTo")}</strong> ${escapeHtml(meta.to ?? "")}</p>`;
}

/** The quote as it leaves in the outgoing mail, marked so a reopened draft can find it again. */
export function renderQuote(quote: ComposeQuote): string {
  if (quote.kind === "raw") return quote.body;
  const custom = quote.header === undefined ? {} : { customHeader: true };
  const marker = escapeHtml(JSON.stringify({ kind: quote.kind, ...quote.meta, ...custom }));
  return `<div ${QUOTE_ATTR}="${marker}">${quote.header ?? generatedHeader(quote)}<blockquote>${quote.body}</blockquote></div>`;
}

/** The quote as the edit frame shows it; the sender line is text the user may change too. */
export function editableQuoteHtml(quote: ComposeQuote): string {
  if (quote.kind === "raw") return quote.body;
  return `${quote.header ?? generatedHeader(quote)}<blockquote>${quote.body}</blockquote>`;
}

function isBlank(node: Node): boolean {
  if (node.textContent?.trim()) return false;
  return !(node instanceof Element) || (node.tagName !== "IMG" && !node.querySelector("img"));
}

function plainText(node: Node): string {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}

function nodesBefore(node: Element): HTMLDivElement {
  const box = node.ownerDocument.createElement("div");
  for (let n = node.parentNode?.firstChild; n && n !== node; n = n.nextSibling) box.appendChild(n.cloneNode(true));
  return box;
}

/** Reads the edit frame back; null once the user deleted the quoted text completely. */
export function applyQuoteEdit(quote: ComposeQuote, edited: string): ComposeQuote | null {
  const root = new DOMParser().parseFromString(edited, "text/html").body;
  if (quote.kind === "raw") return isBlank(root) ? null : { kind: "raw", body: edited };

  let last = root.lastElementChild;
  while (last && last.tagName !== "BLOCKQUOTE" && isBlank(last)) last = last.previousElementSibling;
  if (!last || last.tagName !== "BLOCKQUOTE" || !blankAfter(last)) {
    if (isBlank(root)) return null;
    const marker = escapeHtml(JSON.stringify({ kind: "raw" }));
    return { kind: "raw", body: `<div ${QUOTE_ATTR}="${marker}">${edited}</div>` };
  }
  if (isBlank(last)) return null;

  const next: MailQuote = { kind: quote.kind, meta: quote.meta, body: last.innerHTML };
  const header = nodesBefore(last);
  const generated = new DOMParser().parseFromString(generatedHeader(quote), "text/html").body;
  if (plainText(header) !== plainText(generated)) next.header = isBlank(header) ? "" : header.innerHTML.trim();
  return next;
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
  try {
    const data = JSON.parse(el.getAttribute(QUOTE_ATTR) ?? "");
    const custom = data.customHeader === true;
    const wellFormed =
      blockquote?.tagName === "BLOCKQUOTE" &&
      blankAfter(blockquote) &&
      (custom || Array.from(el.children).slice(0, -1).every((c) => c.tagName === "P"));
    if (wellFormed && (data.kind === "reply" || data.kind === "forward") && typeof data.fromEmail === "string") {
      const meta: QuoteMeta = { fromName: text(data.fromName), fromEmail: data.fromEmail, date: text(data.date) };
      if (data.kind === "forward") {
        meta.subject = text(data.subject);
        meta.to = text(data.to);
      }
      const quote: MailQuote = { kind: data.kind, meta, body: blockquote.innerHTML };
      if (custom) quote.header = nodesBefore(blockquote).innerHTML.trim();
      return quote;
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
