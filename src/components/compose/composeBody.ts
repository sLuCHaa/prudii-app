import type { Editor } from "@tiptap/core";

/** `setContent` alone leaves the cursor at the end, inside the signature's trailing link. */
export function setComposeBody(editor: Editor, html: string) {
  editor.chain().setContent(html).setTextSelection(0).run();
}
