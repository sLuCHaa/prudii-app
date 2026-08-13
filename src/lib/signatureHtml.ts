import { sanitizeSignatureHtml } from "./sanitize";

export interface SignatureModel {
  doc: Document;
  /** Current text of every indexed node, in document order. */
  texts: string[];
  /** The indexed nodes themselves; index matches `texts`. */
  nodes: Text[];
}

/** Elements whose text is markup rather than content. */
const NON_CONTENT = new Set(["STYLE", "SCRIPT", "HEAD", "TITLE", "META", "LINK"]);

function collectTextNodes(doc: Document): Text[] {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const found: Text[] = [];
  let node = walker.nextNode() as Text | null;
  while (node) {
    const parent = node.parentElement;
    // Whitespace between tags carries no content and must not become editable,
    // otherwise the indexes shift as soon as the markup is reformatted.
    if (node.data.trim() && (!parent || !NON_CONTENT.has(parent.tagName))) {
      found.push(node);
    }
    node = walker.nextNode() as Text | null;
  }
  return found;
}

export function parseSignature(html: string): SignatureModel {
  const doc = new DOMParser().parseFromString(sanitizeSignatureHtml(html), "text/html");
  const nodes = collectTextNodes(doc);
  return { doc, nodes, texts: nodes.map((n) => n.data.trim()) };
}

export function serializeSignature(model: SignatureModel): string {
  return model.doc.body.innerHTML;
}

export function setSignatureText(
  model: SignatureModel,
  index: number,
  text: string
): string {
  const node = model.nodes[index];
  if (!node) return serializeSignature(model);
  // Assigning to `data` sets a text node's content, so any markup the user
  // types is stored as characters and can never become elements.
  node.data = text;
  model.texts[index] = text;
  return serializeSignature(model);
}

export function buildPreviewHtml(html: string): string {
  const doc = new DOMParser().parseFromString(sanitizeSignatureHtml(html), "text/html");
  collectTextNodes(doc).forEach((node, index) => {
    const span = doc.createElement("span");
    span.setAttribute("data-sig-text", String(index));
    span.setAttribute("contenteditable", "plaintext-only");
    node.replaceWith(span);
    span.textContent = node.data.trim();
  });
  return doc.body.innerHTML;
}

export function derivePlainText(html: string): string {
  const doc = new DOMParser().parseFromString(sanitizeSignatureHtml(html), "text/html");
  doc.querySelectorAll("style, script, head").forEach((el) => el.remove());
  return (doc.body?.textContent ?? "").replace(/^\s+/, "").trimEnd();
}

// Converts HTML into editable multi-line text, preserving line structure. Used to
// *seed* the plain-text tab's draft (see `plainDraft` in SignatureEditor) — never
// called on every keystroke, so it does not need to be a perfect inverse of
// anything; it just needs to produce a sensible starting point once, without
// dropping content. Deliberately separate from `derivePlainText`: that function is
// for the *stored* `signature_text`, where trailing blank lines are noise and get
// trimmed away; trimming here would eat a leading/trailing blank line that is part
// of what's being seeded. Do not merge the two.
//
// General HTML → line-list conversion, not tied to any one producer's output shape
// (earlier versions of this function assumed it only ever read HTML that
// `commitPlainText` below had generated — that assumption was wrong: the HTML
// source tab can commit arbitrary sanitised markup that also lands here whenever
// it happens to be unstructured). Walks child nodes (not just element children, so
// bare top-level text isn't silently dropped): text appends to the current line;
// `<br>` ends it and starts a new one; a `div`/`p` ends the current line and
// contributes its own rendered line(s); anything else contributes its flattened
// text. A `<br>` with nothing meaningful after it in its own parent is filler
// (that's what makes an empty `<div><br></div>` one blank line, not two) and does
// not end the line.
const BLOCK_TAGS = new Set(["DIV", "P"]);

function hasVisibleContent(node: ChildNode): boolean {
  if (node.nodeType === Node.TEXT_NODE) return (node as Text).data.trim().length > 0;
  return node.nodeType === Node.ELEMENT_NODE;
}

function linesOf(nodes: ChildNode[]): string[] {
  const lines: string[] = [];
  let current = "";
  // True once `current` holds real, deliberate content for this line — as opposed
  // to being merely unstarted. Without this, a block boundary can't tell "nothing
  // came before me, don't flush a spurious blank line" apart from "an explicit
  // empty line came before me, flush it" — that ambiguity is what caused the
  // leading-blank-line regression found in review. Reset after every flush so each
  // fresh line starts genuinely untouched again.
  let dirty = false;

  const flush = () => {
    lines.push(current);
    current = "";
    dirty = false;
  };

  nodes.forEach((node, i) => {
    if (node.nodeType === Node.TEXT_NODE) {
      current += (node as Text).data;
      dirty = true;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;

    if (el.tagName === "BR") {
      const isFiller = !nodes.slice(i + 1).some(hasVisibleContent);
      if (!isFiller) flush();
      return;
    }
    if (BLOCK_TAGS.has(el.tagName)) {
      if (dirty) flush();
      const inner = linesOf(Array.from(el.childNodes));
      lines.push(...(inner.length > 0 ? inner : [""]));
      return;
    }
    current += el.textContent ?? "";
    dirty = true;
  });

  if (dirty) flush();
  return lines;
}

export function htmlToPlainLines(html: string): string {
  const doc = new DOMParser().parseFromString(sanitizeSignatureHtml(html), "text/html");
  doc.querySelectorAll("style, script, head").forEach((el) => el.remove());
  return linesOf(Array.from(doc.body.childNodes)).join("\n");
}

// The guillemets, the spaces and the middle dot cannot occur inside base64, so a
// placeholder is always distinguishable from real payload. The 1-based index sits
// immediately after the opening guillemet, *outside* the human-readable part: that
// part is translated (`signature.imagePlaceholder`), so nothing about matching a
// placeholder may depend on its wording.
const PLACEHOLDER = /‹(\d+) · [^›]*›/g;
const DATA_URI = /data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]+/gi;

/** Renders the human-readable half of an image placeholder, e.g. "image · 11 KB". */
export type ImageLabel = (kb: number) => string;

const DEFAULT_LABEL: ImageLabel = (kb) => `${kb} KB`;

export function collapseDataUris(
  html: string,
  label: ImageLabel = DEFAULT_LABEL
): { html: string; images: string[] } {
  const images: string[] = [];
  const collapsed = html.replace(DATA_URI, (uri) => {
    images.push(uri);
    const kb = Math.max(1, Math.round(uri.length / 1024));
    const prefix = uri.slice(0, uri.indexOf(",") + 1);
    return `${prefix}‹${images.length} · ${label(kb)}›`;
  });
  return { html: collapsed, images };
}

export function expandDataUris(html: string, images: string[]): string {
  return html.replace(PLACEHOLDER, (match, n) => {
    const uri = images[Number(n) - 1];
    if (!uri) return match;
    return uri.slice(uri.indexOf(",") + 1);
  });
}

// Start of every data URI, however malformed its payload — deliberately looser than
// DATA_URI above, which only matches well-formed base64; the point here is to find
// the ones that are *not*.
const DATA_URI_HEAD = /data:[a-z0-9.+/-]+;base64,/gi;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/**
 * The payload starting at `from`, ending where its context says it does. Which
 * delimiter that is has to come from what *opened* the URI, not from the payload:
 * intact base64 contains no whitespace, but a mangled placeholder does, and inside
 * `src="…"` those spaces are still part of the value and must be seen as damage.
 * Stopping at whitespace unconditionally would hide exactly the case worth
 * catching; never stopping at it would read a following attribute, or the `)` of a
 * `url(…)`, as payload and report an intact image as damaged.
 */
function dataUriPayload(html: string, from: number, uriStart: number): string {
  let i = uriStart - 1;
  while (i >= 0 && /\s/.test(html[i])) i -= 1;
  const opener = i >= 0 ? html[i] : "";
  const stop = opener === '"' || opener === "'" ? opener : opener === "(" ? ")" : "";
  if (!stop) return /^[^"'<>\s)]*/.exec(html.slice(from))![0];
  const end = html.indexOf(stop, from);
  return html.slice(from, end === -1 ? html.length : end);
}

/**
 * True when some `data:` URI carries a payload that is not base64 — what is left
 * behind when a collapsed placeholder was edited or half-deleted instead of being
 * removed whole, e.g. `data:image/png;base64,‹1 · image · 11 KB` after the closing
 * guillemet was lost, or a `‹5 · …›` that `expandDataUris` had no image for.
 *
 * Nothing downstream would notice on its own: DOMPurify keeps a `data:` src on an
 * `img` whatever the payload says, and a later collapseDataUris finds no base64 to
 * re-collapse — so the original bytes fall out of state and the image is gone for
 * good on the next save. Callers must check this *after* expanding and refuse the
 * commit rather than store a broken `src`.
 */
export function hasBrokenDataUri(html: string): boolean {
  for (const match of html.matchAll(DATA_URI_HEAD)) {
    const uriStart = match.index ?? 0;
    if (!BASE64.test(dataUriPayload(html, uriStart + match[0].length, uriStart))) return true;
  }
  return false;
}

export function hasStructure(html: string): boolean {
  if (!html.trim()) return false;
  const doc = new DOMParser().parseFromString(sanitizeSignatureHtml(html), "text/html");
  const plain = new Set(["DIV", "P", "BR", "SPAN", "B", "I", "U", "STRONG", "EM"]);
  return Array.from(doc.body.querySelectorAll("*")).some(
    (el) => !plain.has(el.tagName) || el.attributes.length > 0
  );
}
