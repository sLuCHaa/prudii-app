import type { Editor } from "@tiptap/core";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";

/** Goes through the browser first so ProseMirror's copy handler keeps the formatting. */
export function copySelection(editor: Editor, cut: boolean) {
  editor.commands.focus();
  if (typeof document.execCommand === "function" && document.execCommand(cut ? "cut" : "copy")) return;
  const { from, to } = editor.state.selection;
  writeText(editor.state.doc.textBetween(from, to, "\n")).catch(() => {});
  if (cut) editor.commands.deleteSelection();
}
