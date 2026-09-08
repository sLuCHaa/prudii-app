import { useEffect, useRef, useState } from "react";
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

export interface UseRichTextEditorOptions {
  content: string; // initial HTML
  placeholder?: string;
  // Typed as AnyExtension (tiptap's actual union of Extension/Node/Mark) rather than
  // the plain Extension class — ComposeModal passes Node instances (image, signature).
  extraExtensions?: AnyExtension[];
  editorClassName?: string;
  autofocus?: boolean;
  onChange?: (html: string) => void; // on every update
}

/** Shared TipTap setup for Compose and (later) the task description field. */
export function useRichTextEditor({
  content,
  placeholder,
  extraExtensions = [],
  editorClassName = DEFAULT_EDITOR_CLASSNAME,
  autofocus,
  onChange,
}: UseRichTextEditorOptions): Editor | null {
  // Read through a ref so the update listener below is registered once per
  // editor instance and never closes over a stale onChange.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

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
    if (!editor) return;
    const handleUpdate = () => onChangeRef.current?.(editor.getHTML());
    editor.on("update", handleUpdate);
    return () => { editor.off("update", handleUpdate); };
  }, [editor]);

  return editor;
}

export interface RichTextEditorProps {
  content: string; // initial HTML
  onChange?: (html: string) => void; // on every update
  onEditorReady?: (editor: Editor) => void;
  placeholder?: string;
  extraExtensions?: AnyExtension[]; // ComposeModal: [TiptapImage.configure(...), SignatureNode]
  editorClassName?: string;
  /** `"focus"` keeps the toolbar collapsed until something inside the surrounding
   *  `.group` element takes focus — the task drawer's quiet-until-edited card. */
  toolbar?: boolean | "focus";
  autofocus?: boolean;
  onEscapeBlockedChange?: (blocked: boolean) => void; // true while the link dialog is open
}

/** Ready-made toolbar + content, for callers that don't need custom layout (e.g. the task drawer). */
export function RichTextEditor({
  content,
  onChange,
  onEditorReady,
  placeholder,
  extraExtensions,
  editorClassName = DEFAULT_EDITOR_CLASSNAME,
  toolbar = true,
  autofocus,
  onEscapeBlockedChange,
}: RichTextEditorProps) {
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  // Read through a ref: onEditorReady is expected to be a stable setState setter,
  // so it must not force the effect below to re-run on every caller render.
  const onEditorReadyRef = useRef(onEditorReady);
  onEditorReadyRef.current = onEditorReady;

  const editor = useRichTextEditor({ content, placeholder, extraExtensions, editorClassName, autofocus, onChange });

  useEffect(() => {
    if (editor) onEditorReadyRef.current?.(editor);
  }, [editor]);

  useEffect(() => {
    onEscapeBlockedChange?.(linkDialogOpen);
  }, [linkDialogOpen, onEscapeBlockedChange]);

  return (
    <>
      {toolbar === "focus" ? (
        <div className="max-h-0 overflow-hidden opacity-0 transition-all duration-200 group-focus-within:max-h-12 group-focus-within:opacity-100">
          <EditorToolbar editor={editor} linkDialogOpen={linkDialogOpen} setLinkDialogOpen={setLinkDialogOpen} />
        </div>
      ) : toolbar !== false ? (
        <EditorToolbar editor={editor} linkDialogOpen={linkDialogOpen} setLinkDialogOpen={setLinkDialogOpen} />
      ) : null}
      <EditorContent editor={editor} className={editorClassName} />
    </>
  );
}
