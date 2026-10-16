import { Extension, type Editor } from "@tiptap/core";
import { isMacOS } from "../../lib/platform";

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

export interface LinkActionHandlers {
  openMenu: (target: LinkMenuTarget) => void;
  openDialog: () => void;
  openSelectionMenu: (at: { x: number; y: number }) => void;
}

type SelectedRange = [Node | null, number, Node | null, number];

function selectedRange(editor: Editor): SelectedRange | null {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.anchorNode || !editor.view.dom.contains(sel.anchorNode)) return null;
  return [sel.anchorNode, sel.anchorOffset, sel.focusNode, sel.focusOffset];
}

const linkActionOwners = new WeakMap<Editor, LinkActionHandlers>();

/** Routes right-clicks on links and Mod+K to `handlers` until the returned cleanup runs. */
export function onLinkActions(editor: Editor, handlers: LinkActionHandlers) {
  linkActionOwners.set(editor, handlers);
  return () => {
    if (linkActionOwners.get(editor) === handlers) linkActionOwners.delete(editor);
  };
}

interface ActionStorage {
  onMouseDown: ((event: MouseEvent) => void) | null;
  onContextMenu: ((event: MouseEvent) => void) | null;
  onKeyDown: ((event: KeyboardEvent) => void) | null;
}

export const LinkActions = Extension.create<Record<string, never>, ActionStorage>({
  name: "linkActions",
  addStorage() {
    return { onMouseDown: null, onContextMenu: null, onKeyDown: null };
  },
  onCreate() {
    const editor = this.editor;
    let pressed: SelectedRange | null = null;
    const onMouseDown = (event: MouseEvent) => {
      const secondary = event.button === 2 || (isMacOS && event.button === 0 && event.ctrlKey);
      pressed = secondary ? selectedRange(editor) : null;
    };
    const onContextMenu = (event: MouseEvent) => {
      const owner = linkActionOwners.get(editor);
      const before = pressed;
      pressed = null;
      if (!owner || !editor.isEditable) return;
      const anchor = (event.target as Element | null)?.closest?.("a");
      if (anchor) {
        editor.chain().setTextSelection(editor.view.posAtDOM(anchor, 0)).extendMarkRange("link").run();
        const href = editor.getAttributes("link").href;
        if (typeof href !== "string" || !href) return;
        event.preventDefault();
        owner.openMenu({ href, x: event.clientX, y: event.clientY });
        return;
      }
      // A right-click on a misspelled word selects it for the native suggestions; only a selection made beforehand gets the app menu.
      const now = selectedRange(editor);
      if (!before || !now || before.some((part, i) => part !== now[i])) return;
      event.preventDefault();
      owner.openSelectionMenu({ x: event.clientX, y: event.clientY });
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const owner = linkActionOwners.get(editor);
      const mod = isMacOS ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (!owner || !editor.isEditable || !mod || event.shiftKey || event.altKey || event.key.toLowerCase() !== "k") return;
      event.preventDefault();
      // The main window's command palette listens for the same keys on window.
      event.stopPropagation();
      owner.openDialog();
    };
    this.storage.onMouseDown = onMouseDown;
    this.storage.onContextMenu = onContextMenu;
    this.storage.onKeyDown = onKeyDown;
    // Capture phase: the selection has to be read before anything reacts to the press.
    editor.view.dom.addEventListener("mousedown", onMouseDown, true);
    editor.view.dom.addEventListener("contextmenu", onContextMenu);
    editor.view.dom.addEventListener("keydown", onKeyDown);
  },
  onDestroy() {
    const { onMouseDown, onContextMenu, onKeyDown } = this.storage;
    try {
      if (onMouseDown) this.editor.view.dom.removeEventListener("mousedown", onMouseDown, true);
      if (onContextMenu) this.editor.view.dom.removeEventListener("contextmenu", onContextMenu);
      if (onKeyDown) this.editor.view.dom.removeEventListener("keydown", onKeyDown);
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

/** Without a selection there is no text to carry the link, so it brings its own. */
export function applyLink(editor: Editor, href: string, text: string) {
  if (!editor.state.selection.empty || editor.isActive("link")) {
    editor.chain().focus().extendMarkRange("link").setLink({ href }).run();
    return;
  }
  const label = text.trim() || href.replace(/^(mailto|tel):/i, "");
  editor
    .chain()
    .focus()
    .insertContent({ type: "text", text: label, marks: [{ type: "link", attrs: { href } }] })
    .unsetMark("link")
    .run();
}
