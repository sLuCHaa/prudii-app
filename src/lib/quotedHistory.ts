// When in doubt return null: a missed quote costs scrolling, a wrong cut hides what was written.

const SPACE = /[\s ​‌‍﻿]/g;

const ATTRIBUTION_VERBS = "wrote|schrieb|a écrit|escribió|escreveu|ha scritto|написал(?:\\(а\\)|а)?|写道|schreef|napisał|skrev|kirjoitti|yazdı";
const ATTRIBUTION = new RegExp(`(?:${ATTRIBUTION_VERBS}).*[:：]\\s*$`, "i");
// A time or an address tells an attribution from a sentence that ends in "schrieb:".
const ATTRIBUTION_DETAIL = /\d{1,2}:\d{2}|@/;

export const FORWARD_LABELS = "forwarded message|weitergeleitete nachricht|message transféré|mensaje reenviado|mensagem encaminhada|messaggio inoltrato|пересылаемое сообщение|转发邮件|begin forwarded message|anfang der weitergeleiteten nachricht|début du message réexpédié";
const FORWARD_AT_START = new RegExp(`^[-\\s]*(?:${FORWARD_LABELS})`, "i");
const FORWARD_MARKER = new RegExp(`-{2,}\\s*(?:${FORWARD_LABELS})|(?:begin forwarded message|anfang der weitergeleiteten nachricht|début du message réexpédié)\\s*:`, "i");
export const FORWARD_SUBJECT = /^\s*(?:fwd?|wg|tr|rv|enc)\s*:/i;

export const ORIGINAL_SEPARATOR = /^-{2,}\s*(?:original message|ursprüngliche nachricht|originalnachricht|message d'origine|mensaje original|mensagem original|messaggio originale|исходное сообщение|原始邮件)\s*-{2,}$/i;
const HEADER_FROM = /^(?:from|von|de|da|от|发件人|van|od|fra)\s*[:：]/i;
const HEADER_NEXT = /^(?:sent|gesendet|date|datum|envoyé|enviado|enviada|inviato|отправлено|发送时间|verzonden|wysłano|skickat|sendt|to|an|à|para|a|кому|收件人)\s*[:：]/i;
const HEADER_SENT = /(?:sent|gesendet|date|datum|envoyé|enviado|inviato|отправлено|发送时间|verzonden|wysłano|skickat|sendt)\s*[:：]/i;
const HEADER_RECIPIENT = /(?:^|\s)(?:to|an|à|para|a|cc|subject|betreff|objet|asunto|assunto|oggetto|кому|тема|收件人|主题|onderwerp|temat|ämne|emne)\s*[:：]/im;

const QUOTE_CONTAINERS = ".gmail_quote_container, .gmail_quote, .yahoo_quoted, .protonmail_quote, blockquote";
// Blockquotes these clients mark as a reply quote need no attribution in front.
const REPLY_QUOTE_CLASSES = ["gmail_quote", "hs_reply_quote"];
const BLOCK_TAGS = new Set(["DIV", "P", "TABLE", "UL", "OL", "PRE", "BLOCKQUOTE", "HR", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "HEADER", "FOOTER", "CENTER"]);
const SIGNATURE_CLASSES = ["moz-signature", "gmail_signature"];
const SIGNATURE_DELIMITER = /^--[  ]?(?:\n|$|[^-])/;
const MEDIA = "img, video, picture, svg";
const HIDDEN_TAGS = new Set(["STYLE", "SCRIPT", "TITLE", "META", "LINK"]);

export function isForwardSubject(subject: string): boolean {
  return FORWARD_SUBJECT.test(subject);
}

// Before a marked reply quote no verb is needed ("Mittwoch, 17. Dezember 2025, 21:20 +0100, Anna <a@b.de>:").
function isAttribution(text: string, loose = false): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length > 300 || !ATTRIBUTION_DETAIL.test(t)) return false;
  return loose ? /[:：]$/.test(t) : ATTRIBUTION.test(t);
}

export function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE || HIDDEN_TAGS.has((node as Element).tagName)) return "";
  const tag = (node as Element).tagName;
  if (tag === "BR") return "\n";
  let out = "";
  node.childNodes.forEach((child) => { out += visibleText(child); });
  // Line ends keep header labels apart ("11:59" + "Betreff:" in two divs).
  return BLOCK_TAGS.has(tag) || tag === "LI" || tag === "TR" ? `${out}\n` : out;
}

function isTrackingPixel(img: Element): boolean {
  return ["width", "height"].some((a) => /^[01]$/.test(img.getAttribute(a) ?? ""));
}

export function hasVisible(node: Node): boolean {
  if (visibleText(node).replace(SPACE, "") !== "") return true;
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  const media = el.matches(MEDIA) ? [el] : Array.from(el.querySelectorAll(MEDIA));
  return media.some((m) => !isTrackingPixel(m));
}

function isSignatureStart(node: Node): boolean {
  if (node.nodeType === Node.ELEMENT_NODE && SIGNATURE_CLASSES.some((c) => (node as Element).classList.contains(c))) return true;
  return SIGNATURE_DELIMITER.test(visibleText(node).replace(/^\s+/, ""));
}

// Thunderbird puts its signature below the quote even when the reply sits on top.
function hasContentAfter(el: Node, root: Node): boolean {
  for (let node: Node | null = el; node && node !== root; node = node.parentNode) {
    for (let s = node.nextSibling; s; s = s.nextSibling) {
      if (isSignatureStart(s)) return false;
      if (hasVisible(s)) return true;
    }
  }
  return false;
}

const tagOf = (node: Node) => (node.nodeType === Node.ELEMENT_NODE ? (node as Element).tagName : "");

// HubSpot spreads the attribution over inline nodes ("On … <a>x@y</a> wrote:").
function attributionBefore(quote: Node, loose: boolean): Node | null {
  let first: Node | null = null;
  let text = "";
  for (let s = quote.previousSibling; s; s = s.previousSibling) {
    const tag = tagOf(s);
    if (!first && (tag === "BR" || !hasVisible(s))) continue;
    if (tag === "BR") break;
    if (BLOCK_TAGS.has(tag)) {
      if (!first) {
        first = s;
        text = visibleText(s);
      }
      break;
    }
    first = s;
    text = visibleText(s) + text;
  }
  if (!first) return null;
  const citePrefix = first.nodeType === Node.ELEMENT_NODE && (first as Element).classList.contains("moz-cite-prefix");
  return citePrefix || isAttribution(text, loose) ? first : null;
}

function textFrom(start: Node, root: Node, limit = Infinity): string {
  let out = visibleText(start);
  for (let node: Node | null = start; node && node !== root && out.length < limit; node = node.parentNode) {
    for (let s = node.nextSibling; s && out.length < limit; s = s.nextSibling) out += visibleText(s);
  }
  return out;
}

function earliest(nodes: Node[]): Node | null {
  let first: Node | null = null;
  for (const n of nodes) {
    if (!first || n.compareDocumentPosition(first) & Node.DOCUMENT_POSITION_FOLLOWING) first = n;
  }
  return first;
}

// Outlook puts the quoted body after its header as loose siblings, not inside a container.
function findHeaderStart(body: HTMLElement): Node | null {
  const found: Node[] = [];
  const marker = body.querySelector("#appendonsend, #divRplyFwdMsg");
  if (marker) found.push(marker);
  for (const el of Array.from(body.querySelectorAll("div[style*='border-top']"))) {
    const text = visibleText(el).trim();
    if (HEADER_FROM.test(text) && HEADER_SENT.test(text)) {
      found.push(el);
      break;
    }
  }
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (ORIGINAL_SEPARATOR.test((n.nodeValue ?? "").trim())) {
      found.push(n);
      break;
    }
  }
  const labelled = findLabelledHeader(body);
  if (labelled) found.push(labelled);
  return earliest(found);
}

// The "Von: … Gesendet: … An:" block comes in many shapes; only its labels are reliable.
function findLabelledHeader(body: HTMLElement): Node | null {
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!HEADER_FROM.test((n.nodeValue ?? "").trimStart())) continue;
    const head = textFrom(n, body, 600).slice(0, 600);
    if (!HEADER_SENT.test(head) || !HEADER_RECIPIENT.test(head)) continue;
    let start: Node = n;
    while (start.parentNode && start.parentNode !== body && HEADER_FROM.test(visibleText(start.parentNode).trimStart())) {
      start = start.parentNode;
    }
    for (let s = start.previousSibling; s; s = s.previousSibling) {
      if (tagOf(s) === "HR") return s;
      if (hasVisible(s)) break;
    }
    return start;
  }
  return null;
}

/** Nodes to drop: `from` through `to` as siblings, or everything from `from` on when `to` is null. */
interface Cut {
  from: Node;
  to: Node | null;
}

// Anything but a signature after the quote means the answer is below or interleaved.
function findContainerCut(body: HTMLElement): Cut | null {
  const all = Array.from(body.querySelectorAll(QUOTE_CONTAINERS));
  const outermost = all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  const last = outermost[outermost.length - 1];
  if (!last || hasContentAfter(last, body)) return null;
  if (last.tagName !== "BLOCKQUOTE") return { from: last, to: last };
  const marked = last.getAttribute("type") === "cite" || REPLY_QUOTE_CLASSES.some((c) => last.classList.contains(c));
  // Apple Mail wraps the quote in a div of its own, with the attribution before the wrapper.
  for (let node: Node = last; ; ) {
    const attribution = attributionBefore(node, marked);
    if (attribution) return { from: attribution, to: node };
    const parent = node.parentNode;
    if (!parent || parent === body || Array.from(parent.childNodes).some((c) => c !== node && hasVisible(c))) break;
    node = parent;
  }
  return marked ? { from: last, to: last } : null;
}

function removeRange(from: Node, to: Node) {
  for (let n: Node | null = from; n; ) {
    const next: Node | null = n === to ? null : n.nextSibling;
    n.parentNode?.removeChild(n);
    n = next;
  }
}

function cutFrom(start: Node, root: Node) {
  for (let node: Node | null = start; node && node !== root; node = node.parentNode) {
    let s = node.nextSibling;
    while (s) {
      const next = s.nextSibling;
      if (!(s.nodeType === Node.ELEMENT_NODE && (s as Element).tagName === "STYLE")) s.parentNode?.removeChild(s);
      s = next;
    }
  }
  start.parentNode?.removeChild(start);
}

export function trimTrailing(root: Node) {
  let parent = root;
  for (;;) {
    const last = parent.lastChild;
    if (!last) return;
    const holdsStyle = last.nodeType === Node.ELEMENT_NODE && ((last as Element).tagName === "STYLE" || !!(last as Element).querySelector("style"));
    if (!holdsStyle && !hasVisible(last)) {
      parent.removeChild(last);
      continue;
    }
    if (last.nodeType !== Node.ELEMENT_NODE || holdsStyle) return;
    parent = last;
  }
}

/** The HTML without its quoted history, or null when there is none to hide. */
export function stripQuotedHtml(html: string): string | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  const header = findHeaderStart(body);
  const cuts: Cut[] = [findContainerCut(body), header && { from: header, to: null }].filter((c): c is Cut => !!c);
  const first = earliest(cuts.map((c) => c.from));
  const cut = cuts.find((c) => c.from === first);
  if (!cut) return null;
  if (FORWARD_AT_START.test(textFrom(cut.from, body))) return null;
  if (cut.to) removeRange(cut.from, cut.to);
  else cutFrom(cut.from, body);
  trimTrailing(body);
  if (!hasVisible(body) || FORWARD_MARKER.test(visibleText(body))) return null;
  return doc.documentElement.outerHTML;
}

function quotedToEnd(lines: string[], from: number): boolean {
  let seenQuote = false;
  for (let j = from + 1; j < lines.length; j++) {
    const l = lines[j].trim();
    if (l.startsWith(">")) seenQuote = true;
    else if (l && seenQuote) return false;
  }
  return true;
}

function trailingQuoteBlock(lines: string[]): number | null {
  let i = lines.length - 1;
  while (i >= 0 && !lines[i].trim()) i--;
  if (i < 0 || !lines[i].trim().startsWith(">")) return null;
  let start = i;
  for (let j = i - 1; j >= 0; j--) {
    const l = lines[j].trim();
    if (l.startsWith(">")) start = j;
    else if (l) {
      if (l.length <= 200 && ATTRIBUTION.test(l)) start = j;
      break;
    }
  }
  return start;
}

function textQuoteStart(lines: string[]): number | null {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith(">")) continue;
    if (ORIGINAL_SEPARATOR.test(line)) return i;
    if (/^_{8,}$/.test(line) && HEADER_FROM.test((lines[i + 1] ?? "").trim())) return i;
    if (HEADER_FROM.test(line) && lines.slice(i + 1, i + 5).some((l) => HEADER_NEXT.test(l.trim()))) return i;
    // Gmail wraps long attributions, leaving "wrote:" alone on the next line.
    const next = (lines[i + 1] ?? "").trim();
    if (isAttribution(line) || (next.length <= 40 && !next.startsWith(">") && isAttribution(`${line} ${next}`))) {
      return quotedToEnd(lines, i) ? i : null;
    }
  }
  return trailingQuoteBlock(lines);
}

// A "-- " line above the quote belongs to the reply; only one below it is set aside.
function signatureBelowQuote(lines: string[]): number {
  let lastQuoted = -1;
  lines.forEach((l, i) => { if (l.trim().startsWith(">")) lastQuoted = i; });
  if (lastQuoted < 0) return lines.length;
  for (let i = lastQuoted + 1; i < lines.length; i++) if (lines[i].trimEnd() === "--") return i;
  return lines.length;
}

/** The plain text without its quoted history, or null when there is none to hide. */
export function stripQuotedText(text: string): string | null {
  const all = text.replace(/\r\n?/g, "\n").split("\n");
  const sig = signatureBelowQuote(all);
  const lines = all.slice(0, sig);
  const start = textQuoteStart(lines);
  if (start === null) return null;
  const kept = lines.slice(0, start).join("\n").replace(/\s+$/, "");
  if (kept.replace(SPACE, "") === "") return null;
  if (FORWARD_MARKER.test(kept) || FORWARD_AT_START.test(lines.slice(start).join("\n"))) return null;
  const signature = all.slice(sig).join("\n").replace(/\s+$/, "");
  return signature ? `${kept}\n\n${signature}` : kept;
}
