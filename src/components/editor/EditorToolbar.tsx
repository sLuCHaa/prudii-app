import { useCallback, useEffect, useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { Bold, Italic, Strikethrough, RemoveFormatting, List, ListOrdered, Quote, Code, Link2, Undo, Redo, Pencil, ExternalLink, Copy, Unlink, Scissors } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import i18n from "../../lib/i18n";
import { isMacOS } from "../../lib/platform";
import { formatShortcut } from "../../lib/shortcuts";
import type { MenuEntry } from "../../lib/menuModel";
import { useOpenCheckedLink } from "../../hooks/useOpenCheckedLink";
import { ContextMenu } from "../ui/ContextMenu";
import { LinkDialog } from "./LinkDialog";
import { copySelection } from "./clipboard";
import { clearTextFormatting } from "./formatting";
import { applyLink, onLinkActions, selectLinkForEditing } from "./linkEditing";

function label(text: string, keys?: string) {
  return keys ? `${text} (${formatShortcut(keys, isMacOS)})` : text;
}

const toolbarLabel = (action: string, keys?: string) => label(i18n.t(`compose.toolbar.${action}`), keys);

export function EditorToolbar({ editor, linkDialogOpen, setLinkDialogOpen }: { editor: Editor | null; linkDialogOpen: boolean; setLinkDialogOpen: (open: boolean) => void }) {
  const [linkDialogUrl, setLinkDialogUrl] = useState("");
  const [linkDialogEditing, setLinkDialogEditing] = useState(false);
  const [linkDialogAskText, setLinkDialogAskText] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number; href?: string } | null>(null);
  const openCheckedLink = useOpenCheckedLink();

  // Tiptap 3 does not re-render on transactions, so isActive read during render goes stale.
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: !!e?.isActive("bold"),
      italic: !!e?.isActive("italic"),
      underline: !!e?.isActive("underline"),
      strike: !!e?.isActive("strike"),
      bulletList: !!e?.isActive("bulletList"),
      orderedList: !!e?.isActive("orderedList"),
      blockquote: !!e?.isActive("blockquote"),
      codeBlock: !!e?.isActive("codeBlock"),
      link: !!e?.isActive("link"),
      canUndo: !!e?.can().undo(),
      canRedo: !!e?.can().redo(),
    }),
  });

  const openLinkDialog = useCallback(() => {
    if (!editor) return;
    selectLinkForEditing(editor);
    const editing = editor.isActive("link");
    setLinkDialogEditing(editing);
    setLinkDialogAskText(!editing && editor.state.selection.empty);
    setLinkDialogUrl(editing ? editor.getAttributes("link").href || "" : "");
    setLinkDialogOpen(true);
  }, [editor, setLinkDialogOpen]);

  useEffect(
    () => (editor ? onLinkActions(editor, { openMenu: setMenu, openDialog: openLinkDialog, openSelectionMenu: setMenu }) : undefined),
    [editor, openLinkDialog],
  );

  if (!editor || !state) return null;

  const handleLinkSubmit = (url: string, text: string) => {
    applyLink(editor, url, text);
  };

  const handleLinkRemove = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
  };

  const linkMenuEntries = (href: string): MenuEntry[] => [
    { kind: "item", id: "editLink", label: i18n.t("compose.linkEdit"), icon: <Pencil className="w-4 h-4" />, onSelect: openLinkDialog },
    ...(/^https?:/i.test(href)
      ? [{ kind: "item" as const, id: "openLink", label: i18n.t("mailDetail.bodyMenu.openLink"), icon: <ExternalLink className="w-4 h-4" />, onSelect: () => openCheckedLink(href) }]
      : []),
    { kind: "item", id: "copyLink", label: i18n.t("mailDetail.bodyMenu.copyLink"), icon: <Copy className="w-4 h-4" />, onSelect: () => { writeText(href).catch(() => {}); } },
    { kind: "separator" },
    { kind: "item", id: "removeLink", label: i18n.t("compose.linkRemove"), icon: <Unlink className="w-4 h-4" />, danger: true, onSelect: handleLinkRemove },
  ];

  const selectionMenuEntries = (): MenuEntry[] => [
    { kind: "item", id: "insertLink", label: i18n.t("compose.linkInsert"), icon: <Link2 className="w-4 h-4" />, onSelect: openLinkDialog },
    { kind: "item", id: "cut", label: i18n.t("compose.cut"), icon: <Scissors className="w-4 h-4" />, onSelect: () => copySelection(editor, true) },
    { kind: "item", id: "copy", label: i18n.t("mailDetail.bodyMenu.copy"), icon: <Copy className="w-4 h-4" />, onSelect: () => copySelection(editor, false) },
    { kind: "separator" },
    { kind: "item", id: "clearFormatting", label: i18n.t("compose.toolbar.clearFormatting"), icon: <RemoveFormatting className="w-4 h-4" />, onSelect: () => clearTextFormatting(editor) },
  ];

  const buttons = [
    { icon: Bold, action: () => editor.chain().focus().toggleBold().run(), active: state.bold, title: toolbarLabel("bold", "Mod+B") },
    { icon: Italic, action: () => editor.chain().focus().toggleItalic().run(), active: state.italic, title: toolbarLabel("italic", "Mod+I") },
    { icon: () => <span className="font-serif underline text-xs">U</span>, action: () => editor.chain().focus().toggleUnderline().run(), active: state.underline, title: toolbarLabel("underline", "Mod+U") },
    { icon: Strikethrough, action: () => editor.chain().focus().toggleStrike().run(), active: state.strike, title: toolbarLabel("strike", "Mod+Shift+S") },
    { icon: RemoveFormatting, action: () => clearTextFormatting(editor), active: false, title: toolbarLabel("clearFormatting") },
    { type: "divider" as const },
    { icon: List, action: () => editor.chain().focus().toggleBulletList().run(), active: state.bulletList, title: toolbarLabel("bulletList", "Mod+Shift+8") },
    { icon: ListOrdered, action: () => editor.chain().focus().toggleOrderedList().run(), active: state.orderedList, title: toolbarLabel("orderedList", "Mod+Shift+7") },
    { type: "divider" as const },
    { icon: Quote, action: () => editor.chain().focus().toggleBlockquote().run(), active: state.blockquote, title: toolbarLabel("quote") },
    { icon: Code, action: () => editor.chain().focus().toggleCodeBlock().run(), active: state.codeBlock, title: toolbarLabel("codeBlock") },
    { icon: Link2, action: openLinkDialog, active: state.link, title: label(i18n.t("compose.linkInsert"), "Mod+K") },
    { type: "divider" as const },
    { icon: Undo, action: () => editor.chain().focus().undo().run(), active: false, disabled: !state.canUndo, title: toolbarLabel("undo", "Mod+Z") },
    { icon: Redo, action: () => editor.chain().focus().redo().run(), active: false, disabled: !state.canRedo, title: toolbarLabel("redo", isMacOS ? "Mod+Shift+Z" : "Mod+Y") },
  ];

  return (
    <>
      <div className="flex items-center gap-0.5 px-4 py-2 border-b border-border-light bg-bg-secondary">
        {buttons.map((btn, i) => {
          if ("type" in btn && btn.type === "divider") {
            return <div key={i} className="w-px h-5 bg-border mx-1" />;
          }
          const Icon = btn.icon;
          return (
            <button
              key={i}
              tabIndex={-1}
              onClick={btn.action}
              disabled={"disabled" in btn ? btn.disabled : false}
              className={`p-1.5 rounded transition-colors ${
                btn.active
                  ? "bg-accent/20 text-accent"
                  : "disabled" in btn && btn.disabled
                  ? "text-text-tertiary/50 cursor-not-allowed"
                  : "text-text-secondary hover:bg-hover hover:text-text"
              }`}
              title={btn.title}
              aria-label={btn.title}
            >
              {typeof Icon === "function" && Icon.length === 0 ? (
                <Icon />
              ) : (
                <Icon className="w-4 h-4" />
              )}
            </button>
          );
        })}
      </div>

      <LinkDialog
        isOpen={linkDialogOpen}
        onClose={() => setLinkDialogOpen(false)}
        onSubmit={handleLinkSubmit}
        onRemove={handleLinkRemove}
        initialUrl={linkDialogUrl}
        hasExistingLink={linkDialogEditing}
        askText={linkDialogAskText}
      />

      {menu && (
        <ContextMenu
          entries={menu.href ? linkMenuEntries(menu.href) : selectionMenuEntries()}
          x={menu.x}
          y={menu.y}
          onClose={() => setMenu(null)}
        />
      )}
    </>
  );
}
