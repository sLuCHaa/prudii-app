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

export interface LinkMenuTarget {
  href: string;
  x: number;
  y: number;
}

const linkMenuOwners = new WeakMap<Editor, (target: LinkMenuTarget) => void>();

/** Shows `open`'s menu for right-clicked links until the returned cleanup runs. */
export function onLinkContextMenu(editor: Editor, open: (target: LinkMenuTarget) => void) {
  linkMenuOwners.set(editor, open);
  return () => {
    if (linkMenuOwners.get(editor) === open) linkMenuOwners.delete(editor);
  };
}

interface MenuStorage {
  onContextMenu: ((event: MouseEvent) => void) | null;
}

export const LinkContextMenu = Extension.create<Record<string, never>, MenuStorage>({
  name: "linkContextMenu",
  addStorage() {
    return { onContextMenu: null };
  },
  onCreate() {
    const editor = this.editor;
    const onContextMenu = (event: MouseEvent) => {
      const open = linkMenuOwners.get(editor);
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (!open || !editor.isEditable || !anchor) return;
      editor.chain().setTextSelection(editor.view.posAtDOM(anchor, 0)).extendMarkRange("link").run();
      const href = editor.getAttributes("link").href;
      if (typeof href !== "string" || !href) return;
      event.preventDefault();
      open({ href, x: event.clientX, y: event.clientY });
    };
    this.storage.onContextMenu = onContextMenu;
    editor.view.dom.addEventListener("contextmenu", onContextMenu);
  },
  onDestroy() {
    const onContextMenu = this.storage.onContextMenu;
    if (!onContextMenu) return;
    try {
      this.editor.view.dom.removeEventListener("contextmenu", onContextMenu);
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
