import { useEffect, useState } from "react";
import { useEditor, EditorContent, type Editor } from "@tiptap/react";
import type { AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import Placeholder from "@tiptap/extension-placeholder";
import i18n from "../../lib/i18n";
import { EditorToolbar } from "./EditorToolbar";
import { cleanPastedHtml } from "./pasteCleanup";

const DEFAULT_EDITOR_CLASSNAME = "prose prose-sm max-w-none focus:outline-none min-h-[200px] text-text";

export interface RichTextEditorProps {
  content: string; // initial HTML
  onChange?: (html: string) => void; // on every update
  onEditorReady?: (editor: Editor) => void;
  placeholder?: string;
  // Typed as AnyExtension (tiptap's actual union of Extension/Node/Mark) rather than
  // the plain Extension class — ComposeModal passes Node instances (image, signature).
  extraExtensions?: AnyExtension[];
  editorClassName?: string;
  toolbar?: boolean;
  autofocus?: boolean;
  onEscapeBlockedChange?: (blocked: boolean) => void; // true while the link dialog is open
}

/**
 * TipTap editor used by both Compose and (later) the task description field.
 * `toolbar: false` renders nothing here and only manages the editor instance —
 * ComposeModal needs the toolbar and the content area in two non-adjacent
 * spots of its layout (AI-reply suggestions sit between them), so it renders
 * `EditorToolbar`/`EditorContent` itself using the instance from `onEditorReady`.
 */
export function RichTextEditor({
  content,
  onChange,
  onEditorReady,
  placeholder,
  extraExtensions = [],
  editorClassName = DEFAULT_EDITOR_CLASSNAME,
  toolbar = true,
  autofocus,
  onEscapeBlockedChange,
}: RichTextEditorProps) {
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);

  // No deps array (tiptap default `[]`): the editor is created once and never
  // recreated when `content` or the other options change on re-render.
  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        link: false,
        underline: false,
      }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: {
          class: "text-accent underline",
        },
      }),
      Underline,
      Placeholder.configure({
        placeholder: placeholder ?? "",
      }),
      ...extraExtensions,
    ],
    editorProps: {
      attributes: {
        class: editorClassName,
        spellcheck: "true",
        lang: i18n.language,
      },
      // See pasteCleanup.ts: pasted content adopts the editor's own style and
      // oversized clipboard HTML is downgraded to plain text.
      transformPastedHTML: cleanPastedHtml,
    },
    content,
    autofocus,
  });

  useEffect(() => {
    if (editor) onEditorReady?.(editor);
    // onEditorReady is expected to be a stable setState setter; only re-run on a
    // genuinely new editor instance, not on every render of the caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor]);

  useEffect(() => {
    if (!editor || !onChange) return;
    const handleUpdate = () => onChange(editor.getHTML());
    editor.on("update", handleUpdate);
    return () => { editor.off("update", handleUpdate); };
  }, [editor, onChange]);

  useEffect(() => {
    onEscapeBlockedChange?.(linkDialogOpen);
  }, [linkDialogOpen, onEscapeBlockedChange]);

  if (!toolbar) return null;

  return (
    <>
      <EditorToolbar editor={editor} linkDialogOpen={linkDialogOpen} setLinkDialogOpen={setLinkDialogOpen} />
      <EditorContent editor={editor} className={editorClassName} />
    </>
  );
}
