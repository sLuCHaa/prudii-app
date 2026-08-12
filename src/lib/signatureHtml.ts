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

// Converts the plain (`div`/`p`/`br`, no attributes) HTML produced by the plain-text
// tab back into editable multi-line text, preserving line structure so a controlled
// textarea can be driven directly off it without eating newlines the user just typed.
// Deliberately separate from `derivePlainText`: that function is for the *stored*
// `signature_text`, where trailing blank lines are noise and get trimmed away; this
// one feeds a live textarea, where the very last line is very often still blank
// (the user just pressed Enter) and trimming it would erase the newline again —
// reintroducing the bug this function exists to fix. Do not merge the two.
//
// Narrow contract: this only ever runs on the unstructured branch (`hasStructure()`
// is false), where `commitPlainText` below is the sole producer of the HTML — one
// top-level <div> per line, `<br>` as filler for a blank line. That one-block-per-
// line shape is inverted directly here rather than tracked with running state, so
// there is no "are we at the start of the document" case left to get wrong. It does
// not attempt to handle nested divs or arbitrary pasted markup.
function isBrOnlyChild(el: Element): boolean {
  const only = el.firstChild;
  return (
    el.childNodes.length === 1 &&
    only !== null &&
    only.nodeType === Node.ELEMENT_NODE &&
    (only as Element).tagName === "BR"
  );
}

function blockToLine(el: Element): string {
  // `commitPlainText` renders a blank line as `<div><br></div>` — that <br> is
  // filler so the empty div doesn't visually collapse, not a real line break.
  if (isBrOnlyChild(el)) return "";
  let text = "";
  function walk(node: ParentNode) {
    node.childNodes.forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) {
        text += (child as Text).data;
      } else if (child.nodeType === Node.ELEMENT_NODE) {
        const childEl = child as Element;
        if (childEl.tagName === "BR") {
          text += "\n";
        } else {
          walk(childEl);
        }
      }
    });
  }
  walk(el);
  return text;
}

export function htmlToPlainLines(html: string): string {
  const doc = new DOMParser().parseFromString(sanitizeSignatureHtml(html), "text/html");
  doc.querySelectorAll("style, script, head").forEach((el) => el.remove());

  const BLOCK = new Set(["DIV", "P"]);
  const blocks = Array.from(doc.body.children).filter((el) => BLOCK.has(el.tagName));
  // No top-level div/p at all — e.g. an empty signature, or bare text with no
  // wrapping block. Fall back to the raw text content rather than producing nothing.
  if (blocks.length === 0) return doc.body.textContent ?? "";

  return blocks.map(blockToLine).join("\n");
}

// The guillemets and spaces cannot occur inside base64, so a placeholder is
// always distinguishable from real payload.
const PLACEHOLDER = /‹Bild (\d+) · [^›]*›/g;
const DATA_URI = /data:[a-z0-9.+/-]+;base64,[A-Za-z0-9+/=]+/gi;

export function collapseDataUris(html: string): { html: string; images: string[] } {
  const images: string[] = [];
  const collapsed = html.replace(DATA_URI, (uri) => {
    images.push(uri);
    const kb = Math.max(1, Math.round(uri.length / 1024));
    const prefix = uri.slice(0, uri.indexOf(",") + 1);
    return `${prefix}‹Bild ${images.length} · ${kb} KB›`;
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

export function hasStructure(html: string): boolean {
  if (!html.trim()) return false;
  const doc = new DOMParser().parseFromString(sanitizeSignatureHtml(html), "text/html");
  const plain = new Set(["DIV", "P", "BR", "SPAN", "B", "I", "U", "STRONG", "EM"]);
  return Array.from(doc.body.querySelectorAll("*")).some(
    (el) => !plain.has(el.tagName) || el.attributes.length > 0
  );
}
