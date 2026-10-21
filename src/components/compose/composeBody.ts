import type { Editor } from "@tiptap/core";

/** `setContent` alone leaves the cursor at the end, inside the signature's trailing link. */
export function setComposeBody(editor: Editor, html: string) {
  editor.chain().setContent(html).setTextSelection(0).run();
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

/** The distinct `file://` image sources in the body, in document order. */
export function localImageSources(editor: Editor): string[] {
  const sources = new Set<string>();
  editor.state.doc.descendants((node) => {
    const src = node.type.name === "image" ? String(node.attrs.src ?? "") : "";
    if (/^file:\/\//i.test(src)) sources.add(src);
  });
  return [...sources];
}

/** Swap image sources in place, so whatever was typed meanwhile survives; the swap is not an undo step. */
export function replaceImageSources(editor: Editor, bySrc: Map<string, string>) {
  const { tr } = editor.state;
  editor.state.doc.descendants((node, pos) => {
    const next = node.type.name === "image" ? bySrc.get(node.attrs.src) : undefined;
    if (next) tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: next });
  });
  if (tr.docChanged) editor.view.dispatch(tr.setMeta("addToHistory", false));
}
