import { useState } from "react";
import { useEditorState, type Editor } from "@tiptap/react";
import { Bold, Italic, Strikethrough, List, ListOrdered, Quote, Code, Link2, Undo, Redo } from "lucide-react";
import i18n from "../../lib/i18n";
import { LinkDialog } from "./LinkDialog";

export function EditorToolbar({ editor, linkDialogOpen, setLinkDialogOpen }: { editor: Editor | null; linkDialogOpen: boolean; setLinkDialogOpen: (open: boolean) => void }) {
  const [linkDialogUrl, setLinkDialogUrl] = useState("");

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

  if (!editor || !state) return null;

  const openLinkDialog = () => {
    const previousUrl = editor.getAttributes("link").href || "";
    setLinkDialogUrl(previousUrl);
    setLinkDialogOpen(true);
  };

  const handleLinkSubmit = (url: string) => {
    editor.chain().focus().extendMarkRange("link").setLink({ href: url }).run();
  };

  const handleLinkRemove = () => {
    editor.chain().focus().extendMarkRange("link").unsetLink().run();
  };

  const hasExistingLink = state.link;

  const buttons = [
    { icon: Bold, action: () => editor.chain().focus().toggleBold().run(), active: state.bold, title: "Bold (Ctrl+B)" },
    { icon: Italic, action: () => editor.chain().focus().toggleItalic().run(), active: state.italic, title: "Italic (Ctrl+I)" },
    { icon: () => <span className="font-serif underline text-xs">U</span>, action: () => editor.chain().focus().toggleUnderline().run(), active: state.underline, title: "Underline (Ctrl+U)" },
    { icon: Strikethrough, action: () => editor.chain().focus().toggleStrike().run(), active: state.strike, title: "Strikethrough" },
    { type: "divider" as const },
    { icon: List, action: () => editor.chain().focus().toggleBulletList().run(), active: state.bulletList, title: "Bullet List" },
    { icon: ListOrdered, action: () => editor.chain().focus().toggleOrderedList().run(), active: state.orderedList, title: "Numbered List" },
    { type: "divider" as const },
    { icon: Quote, action: () => editor.chain().focus().toggleBlockquote().run(), active: state.blockquote, title: "Quote" },
    { icon: Code, action: () => editor.chain().focus().toggleCodeBlock().run(), active: state.codeBlock, title: "Code Block" },
    { icon: Link2, action: openLinkDialog, active: state.link, title: i18n.t("compose.linkInsert") },
    { type: "divider" as const },
    { icon: Undo, action: () => editor.chain().focus().undo().run(), active: false, disabled: !state.canUndo, title: "Undo (Ctrl+Z)" },
    { icon: Redo, action: () => editor.chain().focus().redo().run(), active: false, disabled: !state.canRedo, title: "Redo (Ctrl+Y)" },
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
        hasExistingLink={hasExistingLink}
      />
    </>
  );
}
