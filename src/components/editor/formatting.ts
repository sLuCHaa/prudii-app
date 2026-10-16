import type { Editor } from "@tiptap/core";

/** Links carry content rather than looks, so they survive; lists and quotes have their own buttons. */
export function clearTextFormatting(editor: Editor) {
  const chain = editor.chain().focus();
  for (const name of Object.keys(editor.schema.marks)) {
    if (name !== "link") chain.unsetMark(name);
  }
  chain.run();
}
