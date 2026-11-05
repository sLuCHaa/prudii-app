import { hasVisible } from "./quotedHistory";

const MARKER = /data-type=["']?signature|gmail_signature|messageSignatureSection|\bid=["']?(?:x_)?Signature\b|moz-signature/i;
const SIGNATURE = '[data-type="signature"], .gmail_signature, [name="messageSignatureSection"], #Signature, #x_Signature, .moz-signature';

export interface SignatureSplit {
  body: string;
  signature: string;
}

function visibleAfter(el: Element, root: Element): boolean {
  for (let node: Node | null = el; node && node !== root; node = node.parentNode) {
    for (let s = node.nextSibling; s; s = s.nextSibling) if (hasVisible(s)) return true;
  }
  return false;
}

function trimEnd(parent: Node) {
  for (let node = parent.lastChild; node; ) {
    const prev: ChildNode | null = node.previousSibling;
    if (node.nodeName !== "STYLE") {
      if (hasVisible(node)) {
        if (node.nodeType === Node.ELEMENT_NODE) trimEnd(node);
        return;
      }
      node.remove();
    }
    node = prev;
  }
}

/** A signature the sender's client marked, cut off the end of the mail's own text so it can be folded. */
export function splitSignature(html: string): SignatureSplit | null {
  if (!MARKER.test(html)) return null;
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  const marked = Array.from(body.querySelectorAll(SIGNATURE)).filter((el) => !el.parentElement?.closest(SIGNATURE));
  const signature = marked[marked.length - 1];
  if (!signature || !hasVisible(signature) || visibleAfter(signature, body)) return null;

  const styles = Array.from(doc.querySelectorAll("style")).filter((s) => !signature.contains(s)).map((s) => s.outerHTML).join("");
  const signatureHtml = styles + signature.outerHTML;
  signature.remove();
  const prefix = Array.from(body.querySelectorAll(".gmail_signature_prefix")).pop();
  if (prefix && !visibleAfter(prefix, body)) prefix.remove();
  if (!hasVisible(body)) return null;
  trimEnd(body);
  return { body: doc.documentElement.outerHTML, signature: signatureHtml };
}
