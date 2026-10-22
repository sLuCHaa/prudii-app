import type { Editor } from "@tiptap/core";
import { hasVisibleContent } from "../../lib/outgoingHtml";
import { parseBody, plainTextParagraph, sanitizeSignatureBlockHtml } from "../../lib/sanitize";
import type { Account } from "../../types";

/** `setContent` alone leaves the cursor at the end; a body that begins with the signature gets an empty line to type in. */
export function setComposeBody(editor: Editor, html: string) {
  editor
    .chain()
    .setContent(html)
    .command(({ tr, state }) => {
      if (tr.doc.firstChild?.type.name === "signature") tr.insert(0, state.schema.nodes.paragraph.create());
      return true;
    })
    .setTextSelection(0)
    .run();
}

/** Whether the body holds anything the user put in; the signature does not count. */
export function hasOwnText(editor: Editor): boolean {
  let own = false;
  editor.state.doc.forEach((node) => {
    if (own || node.type.name === "signature") return;
    if (node.textContent.trim()) own = true;
    else node.descendants((d) => !(own ||= d.type.name === "image"));
  });
  return own;
}

const isLocal = (src: string) => /^file:\/\//i.test(src);

/** The distinct `file://` image sources in the body, in document order; images inside the signature block count too. */
export function localImageSources(editor: Editor): string[] {
  const sources = new Set<string>();
  editor.state.doc.descendants((node) => {
    if (node.type.name === "signature") {
      parseBody(String(node.attrs.html ?? "")).querySelectorAll("img").forEach((img) => {
        const src = img.getAttribute("src") ?? "";
        if (isLocal(src)) sources.add(src);
      });
      return;
    }
    const src = node.type.name === "image" ? String(node.attrs.src ?? "") : "";
    if (isLocal(src)) sources.add(src);
  });
  return [...sources];
}

/** Swap image sources in place, so whatever was typed meanwhile survives; the swap is not an undo step. */
export function replaceImageSources(editor: Editor, bySrc: Map<string, string>) {
  const { tr } = editor.state;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "signature") {
      const body = parseBody(String(node.attrs.html ?? ""));
      let swapped = false;
      body.querySelectorAll("img").forEach((img) => {
        const data = bySrc.get(img.getAttribute("src") ?? "");
        if (!data) return;
        img.setAttribute("src", data);
        swapped = true;
      });
      if (swapped) tr.setNodeMarkup(pos, undefined, { ...node.attrs, html: body.innerHTML });
      return;
    }
    const next = node.type.name === "image" ? bySrc.get(node.attrs.src) : undefined;
    if (next) tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: next });
  });
  if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false));
}

type SignatureSettings = Pick<Account, "signature_html" | "signature_text" | "signature_on_compose" | "signature_on_reply">;

/** The account's signature as a body block, or "" when it is switched off or shows nothing. */
export function accountSignatureHtml(account: SignatureSettings, isReplyOrForward: boolean): string {
  if (!(isReplyOrForward ? account.signature_on_reply : account.signature_on_compose)) return "";
  let inner = "";
  if (account.signature_html) {
    // A pasted signature may be a whole document whose style and head text would otherwise show as text.
    const doc = new DOMParser().parseFromString(account.signature_html, "text/html");
    doc.querySelectorAll("style, script, link, meta, title, head").forEach((el) => el.remove());
    inner = (doc.body?.innerHTML ?? account.signature_html).trim();
  } else if (account.signature_text) {
    inner = plainTextParagraph(account.signature_text);
  }
  return hasVisibleContent(inner) ? `<div data-type="signature">${inner}</div>` : "";
}

function signatureInner(html: string): string {
  const body = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;
  const wrapper = body.children.length === 1 ? body.firstElementChild : null;
  return wrapper?.matches('div[data-type="signature"]') ? wrapper.innerHTML : html;
}

/** Update, remove or append the signature block as a whole; one undo step, the cursor stays. The last block takes the update, any others go. */
export function setSignature(editor: Editor, html: string | null) {
  const inner = html ? sanitizeSignatureBlockHtml(signatureInner(html)) : "";
  const { doc, schema, tr } = editor.state;
  const found: { pos: number; size: number }[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "signature") return;
    found.push({ pos, size: node.nodeSize });
    return false;
  });
  const block = hasVisibleContent(inner) ? schema.nodes.signature.create({ html: inner }) : null;
  if (found.length === 0) {
    if (!block) return;
    tr.insert(doc.content.size, block);
  }
  found.reverse().forEach(({ pos, size }, i) => {
    if (i === 0 && block) tr.replaceWith(pos, pos + size, block);
    else tr.deleteRange(pos, pos + size);
  });
  editor.view.dispatch(tr);
}
