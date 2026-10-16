import { Extension, type Editor } from "@tiptap/core";

interface GuardStorage {
  onClick: ((event: MouseEvent) => void) | null;
}

/** The opener plugin opens every clicked target=_blank link; inside the editor a click must place the cursor. */
export const LinkClickGuard = Extension.create<Record<string, never>, GuardStorage>({
  name: "linkClickGuard",
  addStorage() {
    return { onClick: null };
  },
  onCreate() {
    const editor = this.editor;
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (editor.isEditable && target?.closest?.("a")) event.preventDefault();
    };
    this.storage.onClick = onClick;
    editor.view.dom.addEventListener("click", onClick);
  },
  onDestroy() {
    const onClick = this.storage.onClick;
    if (!onClick) return;
    try {
      this.editor.view.dom.removeEventListener("click", onClick);
    } catch {
      // The view is already gone; its listeners went with it.
    }
  },
});

export function selectLinkForEditing(editor: Editor) {
  const { state } = editor;
  let { from, to } = state.selection;
  if (from !== to) {
    const isSpace = (a: number, b: number) => /^\s$/.test(state.doc.textBetween(a, b, "\n", "\n"));
    while (to > from && isSpace(to - 1, to)) to--;
    while (from < to && isSpace(from, from + 1)) from++;
    editor.commands.setTextSelection({ from, to });
  }
  if (editor.isActive("link")) editor.commands.extendMarkRange("link");
}
