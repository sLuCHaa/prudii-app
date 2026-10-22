import { Node } from "@tiptap/core";
import { hasVisibleContent } from "../../lib/outgoingHtml";
import { sanitizeSignatureBlockHtml } from "../../lib/sanitize";

const BLOCK_TAGS = new Set(["P", "DIV", "TR", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "TABLE"]);

function collectText(node: globalThis.Node, out: string[]) {
  if (node.nodeType === 3) {
    out.push((node.textContent ?? "").replace(/\s+/g, " "));
    return;
  }
  if (node.nodeType !== 1) return;
  const el = node as Element;
  if (el.tagName === "BR") {
    out.push("\n");
    return;
  }
  el.childNodes.forEach((child) => collectText(child, out));
  if (el.tagName === "TD" || el.tagName === "TH") out.push(" ");
  if (BLOCK_TAGS.has(el.tagName)) out.push("\n");
}

export function signatureText(html: string): string {
  const root = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  const parts: string[] = [];
  collectText(root, parts);
  return parts
    .join("")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
}

// An atom: the editor schema cannot hold a designed signature (tables, fonts, colours), so the HTML stays opaque.
export const SignatureNode = Node.create({
  name: "signature",
  group: "block",
  atom: true,
  selectable: true,
  addAttributes() {
    return { html: { default: "" } };
  },
  parseHTML() {
    return [
      {
        tag: 'div[data-type="signature"]',
        getAttrs: (el) => {
          const copy = (el as HTMLElement).cloneNode(true) as HTMLElement;
          copy.querySelectorAll("table[data-prudii-divider]").forEach((divider) => divider.remove());
          const html = sanitizeSignatureBlockHtml(copy.innerHTML);
          return hasVisibleContent(html) ? { html } : false;
        },
      },
    ];
  },
  renderHTML({ node }) {
    // Built in an inert document: a live one would decode and fetch the images on every getHTML (autosave, send, preview).
    const dom = document.implementation.createHTMLDocument("").createElement("div");
    dom.setAttribute("data-type", "signature");
    dom.innerHTML = sanitizeSignatureBlockHtml(node.attrs.html as string);
    return dom;
  },
  addNodeView() {
    return ({ node }) => {
      const dom = document.createElement("div");
      dom.setAttribute("data-type", "signature");
      dom.setAttribute("contenteditable", "false");
      // A shadow root keeps the editor's and Tailwind's styles out, so only browser defaults apply, as at the recipient.
      const shown = dom.attachShadow({ mode: "open" });
      shown.innerHTML = sanitizeSignatureBlockHtml(node.attrs.html as string);
      const keepLinksShut = (event: Event) => {
        if ((event.target as Element | null)?.closest?.("a")) event.preventDefault();
      };
      shown.addEventListener("click", keepLinksShut);
      shown.addEventListener("auxclick", keepLinksShut);
      return { dom, ignoreMutation: () => true };
    };
  },
  renderText({ node }) {
    const text = signatureText(node.attrs.html as string);
    // "-- " on a line of its own is the standard delimiter mail programs recognise a signature by.
    return text ? `-- \n${text}` : "";
  },
});
