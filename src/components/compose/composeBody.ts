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
