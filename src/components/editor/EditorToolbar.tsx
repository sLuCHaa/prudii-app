import { useState } from "react";
import type { Editor } from "@tiptap/react";
import { Bold, Italic, Strikethrough, List, ListOrdered, Quote, Code, Link2, Undo, Redo } from "lucide-react";
import i18n from "../../lib/i18n";
import { LinkDialog } from "./LinkDialog";

export function EditorToolbar({ editor, linkDialogOpen, setLinkDialogOpen }: { editor: Editor | null; linkDialogOpen: boolean; setLinkDialogOpen: (open: boolean) => void }) {
  const [linkDialogUrl, setLinkDialogUrl] = useState("");

  if (!editor) return null;

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

  const hasExistingLink = editor.isActive("link");

  const buttons = [
    { icon: Bold, action: () => editor.chain().focus().toggleBold().run(), active: editor.isActive("bold"), title: "Bold (Ctrl+B)" },
    { icon: Italic, action: () => editor.chain().focus().toggleItalic().run(), active: editor.isActive("italic"), title: "Italic (Ctrl+I)" },
    { icon: () => <span className="font-serif underline text-xs">U</span>, action: () => editor.chain().focus().toggleUnderline().run(), active: editor.isActive("underline"), title: "Underline (Ctrl+U)" },
    { icon: Strikethrough, action: () => editor.chain().focus().toggleStrike().run(), active: editor.isActive("strike"), title: "Strikethrough" },
    { type: "divider" as const },
    { icon: List, action: () => editor.chain().focus().toggleBulletList().run(), active: editor.isActive("bulletList"), title: "Bullet List" },
    { icon: ListOrdered, action: () => editor.chain().focus().toggleOrderedList().run(), active: editor.isActive("orderedList"), title: "Numbered List" },
    { type: "divider" as const },
    { icon: Quote, action: () => editor.chain().focus().toggleBlockquote().run(), active: editor.isActive("blockquote"), title: "Quote" },
    { icon: Code, action: () => editor.chain().focus().toggleCodeBlock().run(), active: editor.isActive("codeBlock"), title: "Code Block" },
    { icon: Link2, action: openLinkDialog, active: editor.isActive("link"), title: i18n.t("compose.linkInsert") },
    { type: "divider" as const },
    { icon: Undo, action: () => editor.chain().focus().undo().run(), active: false, disabled: !editor.can().undo(), title: "Undo (Ctrl+Z)" },
    { icon: Redo, action: () => editor.chain().focus().redo().run(), active: false, disabled: !editor.can().redo(), title: "Redo (Ctrl+Y)" },
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
