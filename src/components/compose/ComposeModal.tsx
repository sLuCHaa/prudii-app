import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from "react";
import type { ReactNode } from "react";
import { formatDistanceToNowStrict } from "date-fns";
import { PulseDot } from "../motion/PulseDot";
import { GradientAvatar } from "../motion/GradientAvatar";
import { SPRING_SNAPPY } from "../motion/tokens";
import { X, Paperclip, Trash2, Send, File, FileText, Image, Film, Music, FileCode, FileSpreadsheet, Archive, Bold, Italic, Strikethrough, List, ListOrdered, Quote, Code, Link2, Undo, Redo, ExternalLink, Unlink, Sparkles, Loader2, FileType, CalendarClock, ChevronDown, Pencil, Check } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useEditor, EditorContent, Editor } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import TiptapImage from "@tiptap/extension-image";
import Placeholder from "@tiptap/extension-placeholder";
import { Node } from "@tiptap/core";
import { useTranslation } from "react-i18next";
import i18n from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import type { ComposeSnapshot } from "../../stores/appStore";
import { useAccounts } from "../../hooks/useAccounts";
import { useScroller } from "../../hooks/useScroller";
import { useDialog } from "../ui/DialogProvider";
import { IconButton } from "../ui/Button";
import { listen, emit } from "@tauri-apps/api/event";
import { saveDraft, syncAccount, fetchMailBody, suggestReplies, sendMail, scheduleSend, listTemplates, listAttachments, getAttachmentPreview, trashMail } from "../../lib/tauri";
import type { AiRepliesEvent, EmailTemplate, ReplySuggestion } from "../../types";
import { escapeHtml } from "../../lib/sanitize";
import { HtmlMailFrame } from "../layout/MailDetail";
import { RecipientInput, type RecipientInputHandle } from "./RecipientInput";
import type { Mail, SendMailRequest, Account, AppSettings } from "../../types";

interface AttachmentFile {
  name: string;
  size: number;
  type: string;
  data: string; // base64
}

function getFileIcon(mimeType: string, filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  if (mimeType.startsWith("image/")) return Image;
  if (mimeType.startsWith("video/")) return Film;
  if (mimeType.startsWith("audio/")) return Music;
  if (mimeType.includes("pdf")) return FileText;
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel")) return FileSpreadsheet;
  if (mimeType.includes("zip") || mimeType.includes("rar") || mimeType.includes("7z") || mimeType.includes("tar")) return Archive;
  if (mimeType.includes("javascript") || mimeType.includes("json") || mimeType.includes("html") || mimeType.includes("css") || mimeType.includes("xml")) return FileCode;

  if (["jpg", "jpeg", "png", "gif", "svg", "webp", "bmp", "ico"].includes(ext)) return Image;
  if (["mp4", "mov", "avi", "mkv", "webm", "wmv"].includes(ext)) return Film;
  if (["mp3", "wav", "ogg", "flac", "aac", "m4a"].includes(ext)) return Music;
  if (["pdf", "doc", "docx", "txt", "rtf", "odt"].includes(ext)) return FileText;
  if (["xls", "xlsx", "csv", "ods"].includes(ext)) return FileSpreadsheet;
  if (["zip", "rar", "7z", "tar", "gz"].includes(ext)) return Archive;
  if (["js", "ts", "jsx", "tsx", "html", "css", "json", "xml", "py", "java", "c", "cpp", "h", "rs", "go"].includes(ext)) return FileCode;

  return File;
}

function getFileColor(mimeType: string, filename: string) {
  const ext = filename.split(".").pop()?.toLowerCase() || "";

  // Media (image/video/audio) — accent color (brand highlight)
  if (mimeType.startsWith("image/") || ["jpg", "jpeg", "png", "gif", "svg", "webp", "bmp", "ico"].includes(ext)) return "text-accent";
  if (mimeType.startsWith("video/") || ["mp4", "mov", "avi", "mkv", "webm", "wmv"].includes(ext)) return "text-accent";
  if (mimeType.startsWith("audio/") || ["mp3", "wav", "ogg", "flac", "aac", "m4a"].includes(ext)) return "text-accent";

  // Documents (pdf, spreadsheet) — secondary text (subdued, professional)
  if (mimeType.includes("pdf") || ext === "pdf") return "text-text-secondary";
  if (mimeType.includes("spreadsheet") || mimeType.includes("excel") || ["xls", "xlsx", "csv", "ods"].includes(ext)) return "text-text-secondary";

  // Archives, code, other — tertiary (most subdued)
  if (mimeType.includes("zip") || mimeType.includes("rar") || mimeType.includes("7z") || mimeType.includes("tar") || ["zip", "rar", "7z", "tar", "gz"].includes(ext)) return "text-text-tertiary";
  if (mimeType.includes("javascript") || mimeType.includes("json") || mimeType.includes("html") || mimeType.includes("css") || mimeType.includes("xml") || ["js", "ts", "jsx", "tsx", "html", "css", "json", "xml", "py", "java", "c", "cpp", "h", "rs", "go"].includes(ext)) return "text-text-tertiary";

  return "text-text-tertiary";
}

function LinkDialog({
  isOpen,
  onClose,
  onSubmit,
  onRemove,
  initialUrl,
  hasExistingLink,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (url: string) => void;
  onRemove: () => void;
  initialUrl: string;
  hasExistingLink: boolean;
}) {
  const [url, setUrl] = useState(initialUrl);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setUrl(initialUrl);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialUrl]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (url.trim()) {
      let finalUrl = url.trim();
      if (!/^https?:\/\//i.test(finalUrl)) {
        finalUrl = "https://" + finalUrl;
      }
      onSubmit(finalUrl);
    }
    onClose();
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center modal-backdrop">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-surface rounded-xl shadow-lg w-full max-w-md overflow-hidden"
      >
        <form onSubmit={handleSubmit}>
          <div className="px-4 py-3 border-b border-border bg-bg-secondary flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Link2 className="w-4 h-4 text-accent" />
              <h3 className="text-sm font-semibold text-text">
                {hasExistingLink ? i18n.t("compose.linkEdit") : i18n.t("compose.linkInsert")}
              </h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-hover transition-colors text-text-tertiary"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4">
            <label className="block text-xs font-medium text-text-secondary mb-2">
              URL
            </label>
            <div className="relative">
              <ExternalLink className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
              <input
                ref={inputRef}
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-border bg-bg-secondary text-sm text-text placeholder:text-text-secondary focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>
          </div>

          <div className="px-4 py-3 border-t border-border bg-bg-secondary flex items-center justify-between">
            {hasExistingLink ? (
              <button
                type="button"
                onClick={() => {
                  onRemove();
                  onClose();
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-danger hover:bg-danger/10 transition-colors"
              >
                <Unlink className="w-4 h-4" />
                {i18n.t("compose.linkRemove")}
              </button>
            ) : (
              <div />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 rounded-lg text-sm text-text-secondary hover:bg-hover transition-colors"
              >
                {i18n.t("common.cancel")}
              </button>
              <button
                type="submit"
                disabled={!url.trim()}
                className="px-4 py-1.5 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {hasExistingLink ? i18n.t("compose.linkUpdate") : i18n.t("compose.linkInsertBtn")}
              </button>
            </div>
          </div>
        </form>
      </motion.div>
    </div>
  );
}

function EditorToolbar({ editor, linkDialogOpen, setLinkDialogOpen }: { editor: Editor | null; linkDialogOpen: boolean; setLinkDialogOpen: (open: boolean) => void }) {
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

// Custom TipTap node to preserve signature wrapper for find/replace on account change
const SignatureNode = Node.create({
  name: "signature",
  group: "block",
  content: "block*",
  parseHTML() {
    return [{ tag: 'div[data-type="signature"]' }];
  },
  renderHTML() {
    return ["div", { "data-type": "signature" }, 0];
  },
});

export type ComposeMode = "new" | "reply" | "replyAll" | "forward" | "draft";

function splitAddressList(input: string): string[] {
  const segments: string[] = [];
  let current = "";
  let inQuotes = false;
  let inAngle = false;
  for (const ch of input) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (!inQuotes && ch === "<") {
      inAngle = true;
    } else if (!inQuotes && ch === ">") {
      inAngle = false;
    } else if (ch === "," && !inQuotes && !inAngle) {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);

  const recipients: string[] = [];
  let pending: string[] = [];
  for (const segment of segments) {
    pending.push(segment);
    if (segment.includes("@")) {
      recipients.push(pending.join(",").trim());
      pending = [];
    }
  }
  if (pending.join(",").trim()) {
    recipients.push(pending.join(",").trim());
  }
  return recipients.filter(Boolean);
}

function parseRecipients(input: string): { email: string; name?: string }[] {
  if (!input.trim()) return [];
  return splitAddressList(input).map((trimmed) => {
    const match = trimmed.match(/^(.+?)\s*<(.+?)>$/);
    if (match) {
      return { name: match[1].trim().replace(/^"|"$/g, "").trim(), email: match[2].trim() };
    }
    return { email: trimmed };
  });
}

/** Format a MailAddress as a recipient chip string, handling missing/invalid emails */
function formatAddress(addr: { name: string; email: string }): string | null {
  const emailLike = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (addr.email && emailLike.test(addr.email)) {
    // Only use display name if it's a clean phrase — names containing '@' or '<>'
    // produce RFC 5322 parse failures and break the send pipeline.
    const cleanName = addr.name?.trim() ?? "";
    const nameUsable = cleanName && !cleanName.includes('@') && !cleanName.includes('<') && !cleanName.includes('>');
    return nameUsable ? `${cleanName} <${addr.email}>` : addr.email;
  }
  // email field is missing/invalid — check if the name contains a valid email
  if (addr.name && emailLike.test(addr.name)) {
    return addr.name;
  }
  return null;
}

// Build the RFC 5322 References chain for a reply: the original's References
// header (full ancestry) followed by the original's own Message-ID.
function buildReferencesChain(mail: Mail | null | undefined): string | undefined {
  if (!mail?.message_id) return undefined;
  const prior = (mail.references || mail.in_reply_to || "").trim();
  const chain = prior ? `${prior} ${mail.message_id}` : mail.message_id;
  const seen = new Set<string>();
  const ids = chain.split(/\s+/).filter((id) => id && !seen.has(id) && seen.add(id));
  return ids.join(" ") || undefined;
}

function generateReplySubject(subject: string): string {
  if (subject.toLowerCase().startsWith("re:")) return subject;
  return `Re: ${subject}`;
}

function generateForwardSubject(subject: string): string {
  if (subject.toLowerCase().startsWith("fwd:") || subject.toLowerCase().startsWith("fw:")) return subject;
  return `Fwd: ${subject}`;
}

function safeFormatDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    return isNaN(d.getTime()) ? dateStr || "" : d.toLocaleString();
  } catch {
    return dateStr || "";
  }
}

function plainTextToQuotedHtml(text: string): string {
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  // Format=flowed heuristic: a trailing space before a single \n marks a soft wrap.
  // Merge it with the next line. Preserve \n\n paragraph breaks.
  const unwrapped = normalized.replace(/ \n(?!\n)/g, " ");
  return unwrapped
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function cleanEmailHtml(html: string): string {
  return html
    .replace(/<o:p\b[^>]*>[\s\S]*?<\/o:p>/gi, "")
    .replace(/<o:p\b[^>]*\/>/gi, "")
    .replace(/\sstyle="[^"]*mso-[^"]*"/gi, "")
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, "");
}

function generateReplyBodyHtml(mail: Mail): string {
  const date = escapeHtml(safeFormatDate(mail.date));
  const from = mail.from.name
    ? `${escapeHtml(mail.from.name)} &lt;${escapeHtml(mail.from.email)}&gt;`
    : escapeHtml(mail.from.email);
  const intro = i18n.t("compose.replyIntro", { date, from });
  const quotedContent = mail.body_html
    ? cleanEmailHtml(mail.body_html)
    : plainTextToQuotedHtml(mail.body_text || "");
  return `<p>${intro}</p><blockquote>${quotedContent}</blockquote>`;
}

function findBestFromAccount(
  originalMail: Mail,
  accounts: { id: string; email: string }[],
  fallbackAccountId: string,
): string {
  const accountByEmail = new Map<string, string>();
  for (const acc of accounts) {
    accountByEmail.set(acc.email.toLowerCase(), acc.id);
  }

  const allRecipients = [
    ...originalMail.to,
    ...originalMail.cc,
    ...originalMail.bcc,
  ];

  for (const addr of allRecipients) {
    const match = accountByEmail.get(addr.email.toLowerCase());
    if (match) return match;
  }

  if (accounts.find((a) => a.id === originalMail.account_id)) {
    return originalMail.account_id;
  }

  return fallbackAccountId;
}

function generateForwardBodyHtml(mail: Mail): string {
  const date = escapeHtml(safeFormatDate(mail.date));
  const from = mail.from.name
    ? `${escapeHtml(mail.from.name)} &lt;${escapeHtml(mail.from.email)}&gt;`
    : escapeHtml(mail.from.email);
  const to = mail.to
    .map((t) => (t.name ? `${escapeHtml(t.name)} &lt;${escapeHtml(t.email)}&gt;` : escapeHtml(t.email)))
    .join(", ");
  const subject = escapeHtml(mail.subject);
  const title = i18n.t("compose.forwardHeaderTitle");
  const fromLabel = i18n.t("compose.forwardHeaderFrom");
  const dateLabel = i18n.t("compose.forwardHeaderDate");
  const subjectLabel = i18n.t("compose.forwardHeaderSubject");
  const toLabel = i18n.t("compose.forwardHeaderTo");
  const content = mail.body_html
    ? cleanEmailHtml(mail.body_html)
    : plainTextToQuotedHtml(mail.body_text || "");
  return (
    `<p>${title}</p>` +
    `<p><strong>${fromLabel}</strong> ${from}</p>` +
    `<p><strong>${dateLabel}</strong> ${date}</p>` +
    `<p><strong>${subjectLabel}</strong> ${subject}</p>` +
    `<p><strong>${toLabel}</strong> ${to}</p>` +
    `<blockquote>${content}</blockquote>`
  );
}

// --- Data passed from the main window to a compose window via event ---
export interface ComposeInitData {
  mode: ComposeMode;
  originalMail?: Mail | null;
  accounts: Account[];
  appSettings: AppSettings;
  selectedAccountId: string | null;
  darkMode: boolean;
  mailtoParams?: { to: string[]; cc: string[]; bcc: string[]; subject: string; body: string } | null;
  aiReplyText?: string | null;
  snapshot?: ComposeSnapshot | null;
}

// --- ComposeForm: the reusable compose form, used by both ComposeModal and ComposeWindow ---

export interface ComposeFormHandle {
  /** Trigger the discard check (shows draft dialog if there's content, else closes) */
  requestClose: () => void;
}

export interface ComposeFormProps {
  isOpen: boolean;
  onClose: () => void;
  mode: ComposeMode;
  originalMail?: Mail | null;
  /** When provided, these override the store-based data (used in separate window) */
  initData?: ComposeInitData | null;
}

type SendPhase = "idle" | "loading" | "sent";

function SendButton({ onSend, disabled }: { onSend: () => Promise<boolean>; disabled: boolean }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<SendPhase>("idle");
  const [hovered, setHovered] = useState(false);

  // Green is the "go" colour: it glides in on hover (a ready-to-send cue) and
  // stays through sending → sent, so the whole send gesture reads as one
  // continuous green journey. Resting idle stays on the brand gradient.
  const greenOn = phase !== "idle" || (hovered && !disabled);

  async function handleClick() {
    if (phase !== "idle" || disabled) return;
    setPhase("loading");
    try {
      const sent = await onSend();
      // Aborted (cancelled dialog, validation error) — reset so the button stays usable.
      if (!sent) {
        setPhase("idle");
        return;
      }
      setPhase("sent");
    } catch {
      setPhase("idle");
    }
  }

  // All three phases live in one grid cell and overlap. Only opacity/scale
  // animate, so the icon never vanishes into an empty button and nothing
  // slides vertically — a calm crossfade between idle → loading → sent.
  const phases: { key: SendPhase; icon: ReactNode; label: string }[] = [
    { key: "idle", icon: <Send className="w-4 h-4" />, label: t("common.send") },
    { key: "loading", icon: <Loader2 className="w-4 h-4 animate-spin" />, label: t("common.sending") },
    { key: "sent", icon: <Check className="w-4 h-4" />, label: t("common.sent") },
  ];

  return (
    <motion.button
      onClick={handleClick}
      onHoverStart={() => setHovered(true)}
      onHoverEnd={() => setHovered(false)}
      disabled={disabled || phase !== "idle"}
      className="relative overflow-hidden px-5 py-2 rounded-l-xl text-white font-semibold text-sm min-w-[100px]"
      transition={SPRING_SNAPPY}
    >
        {/* Base brand gradient (always present). */}
        <span className="absolute inset-0" style={{ background: "var(--gradient-cool)" }} aria-hidden />
        {/* Success-green overlay: glides in on hover and stays through send → sent. */}
        <motion.span
          className="absolute inset-0"
          style={{ background: "var(--c-success)" }}
          initial={false}
          animate={{ opacity: greenOn ? 1 : 0 }}
          transition={SPRING_SNAPPY}
          aria-hidden
        />
        {/* Grid auto-sizes to the widest label across locales; children stack. */}
        <span className="relative grid place-items-center">
          {phases.map((p) => (
            <motion.span
              key={p.key}
              style={{ gridArea: "1 / 1", pointerEvents: "none" }}
              className="inline-flex items-center gap-1.5 whitespace-nowrap"
              initial={false}
              animate={{ opacity: phase === p.key ? 1 : 0, scale: phase === p.key ? 1 : 0.85 }}
              transition={SPRING_SNAPPY}
              aria-hidden={phase !== p.key}
            >
              {p.icon}
              {p.label}
            </motion.span>
          ))}
        </span>
    </motion.button>
  );
}

export const ComposeForm = forwardRef<ComposeFormHandle, ComposeFormProps>(function ComposeForm({ isOpen, onClose, mode, originalMail, initData }, ref) {
  const { t } = useTranslation();
  const scrollRef = useScroller<HTMLDivElement>();

  // In separate window mode, use initData; in modal mode, use hooks/store
  const { data: hookAccounts } = useAccounts();
  const accounts = initData?.accounts ?? hookAccounts;

  const storeSelectedAccountId = useAppStore((s) => s.selectedAccountId);
  const selectedAccountId = initData?.selectedAccountId ?? storeSelectedAccountId;

  const storeAppSettings = useAppStore((s) => s.appSettings);
  const appSettings = initData?.appSettings ?? storeAppSettings;

  const startUndoSend = useAppStore((s) => s.startUndoSend);
  const undoSendSnapshot = useAppStore((s) => s.undoSend.composeSnapshot);
  const storeMailtoParams = useAppStore((s) => s.composeMailtoParams);
  const mailtoParams = initData?.mailtoParams ?? storeMailtoParams;
  const storeAiReplyText = useAppStore((s) => s.composeAiReplyText);
  const composeAiReplyText = initData?.aiReplyText ?? storeAiReplyText;

  const hasFeature = useAppStore((s) => s.hasFeature);
  const addToast = useAppStore((s) => s.addToast);

  const [fromAccountId, setFromAccountId] = useState<string>("");
  const [to, setTo] = useState<string[]>([]);
  const [cc, setCc] = useState<string[]>([]);
  const [bcc, setBcc] = useState<string[]>([]);
  const toFieldRef = useRef<RecipientInputHandle>(null);
  const ccFieldRef = useRef<RecipientInputHandle>(null);
  const bccFieldRef = useRef<RecipientInputHandle>(null);
  const [subject, setSubject] = useState("");
  const [showCc, setShowCc] = useState(true);
  const [showBcc, setShowBcc] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<AttachmentFile[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [showDiscardDialog, setShowDiscardDialog] = useState(false);
  const [linkDialogOpen, setLinkDialogOpen] = useState(false);
  const [savingDraft, setSavingDraft] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<Date | null>(null);
  const [, setRelativeTick] = useState(0);
  const [aiReplies, setAiReplies] = useState<ReplySuggestion[]>([]);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiRequestId, setAiRequestId] = useState<string | null>(null);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);
  const [showScheduleMenu, setShowScheduleMenu] = useState(false);
  const [quotedHtml, setQuotedHtml] = useState("");

  const emailsOf = (list: string[]) => list.map((r) => {
    const m = r.match(/<([^>]+)>/);
    return (m ? m[1] : r).trim().toLowerCase();
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const templateBtnRef = useRef<HTMLDivElement>(null);
  const scheduleBtnRef = useRef<HTMLDivElement>(null);
  const dragCounter = useRef(0);

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
      TiptapImage.configure({
        inline: true,
        allowBase64: true,
      }),
      Placeholder.configure({
        placeholder: i18n.t("compose.writeMessage"),
      }),
      SignatureNode,
    ],
    editorProps: {
      attributes: {
        class: "prose prose-sm max-w-none focus:outline-none min-h-[200px] text-text",
      },
    },
    content: "",
  });

  const getSignatureHtml = useCallback((accountId: string, isReplyOrForward: boolean): string => {
    const account = accounts?.find((a) => a.id === accountId);
    if (!account) return "";

    if (isReplyOrForward && !account.signature_on_reply) return "";
    if (!isReplyOrForward && !account.signature_on_compose) return "";

    if (account.signature_html) {
      // The stored signature may be a full HTML document (e.g. pasted with
      // <style>/<head>). Parse it and strip non-content elements so their CSS/JS
      // text isn't rendered as visible text in the editor; keep only the body.
      const doc = new DOMParser().parseFromString(account.signature_html, "text/html");
      doc.querySelectorAll("style, script, link, meta, title, head").forEach((el) => el.remove());
      const bodyContent = (doc.body?.innerHTML ?? account.signature_html).trim();
      return `<div data-type="signature">${bodyContent}</div>`;
    } else if (account.signature_text) {
      return `<div data-type="signature"><p>--<br>${escapeHtml(account.signature_text).replace(/\n/g, "<br>")}</p></div>`;
    }
    return "";
  }, [accounts]);

  useEffect(() => {
    let cancelled = false;
    if (!isOpen || !editor) return;

    setSendError(null);
    setQuotedHtml("");

    let defaultAccountId = selectedAccountId || accounts?.[0]?.id || "";
    // For reply/forward in unified inbox, pick the account that received the original mail
    if (originalMail && (mode === "reply" || mode === "replyAll" || mode === "forward")) {
      defaultAccountId = findBestFromAccount(originalMail, accounts ?? [], defaultAccountId);
    }
    if (accounts && accounts.length > 0) {
      setFromAccountId(defaultAccountId);
    }

    const isReplyOrForward = mode === "reply" || mode === "replyAll" || mode === "forward";
    const signature = getSignatureHtml(defaultAccountId, isReplyOrForward);

    async function loadAttachmentsFrom(mailId: string) {
      try {
        await fetchMailBody(mailId);
        if (cancelled) return;
        const atts = await listAttachments(mailId);
        if (cancelled) return;
        const files: AttachmentFile[] = [];
        for (const att of atts.filter((a) => !a.is_inline)) {
          if (cancelled) return;
          try {
            const dataUri = await getAttachmentPreview(att.id);
            const base64 = dataUri?.split(",")[1];
            if (base64) {
              files.push({
                name: att.filename,
                size: att.size_bytes ?? 0,
                type: att.mime_type ?? "application/octet-stream",
                data: base64,
              });
            }
          } catch { /* skip unreadable attachments */ }
        }
        if (cancelled) return;
        setAttachments(files);
      } catch { /* leave the composer without attachments */ }
    }

    let content = "";

    if (mode === "draft" && originalMail) {
      const toFormatted = originalMail.to.map((r) =>
        r.name ? `${r.name} <${r.email}>` : r.email
      );
      const ccFormatted = originalMail.cc.map((r) =>
        r.name ? `${r.name} <${r.email}>` : r.email
      );
      const bccFormatted = originalMail.bcc.map((r) =>
        r.name ? `${r.name} <${r.email}>` : r.email
      );
      setTo(toFormatted);
      setCc(ccFormatted);
      setBcc(bccFormatted);
      setShowCc(ccFormatted.length > 0);
      setShowBcc(bccFormatted.length > 0);
      setSubject(originalMail.subject || "");
      setAttachments([]);
      if (originalMail.has_attachments) {
        void loadAttachmentsFrom(originalMail.id);
      }
      if (originalMail.account_id) {
        setFromAccountId(originalMail.account_id);
      }
      // Use draft body as-is (no signature injection)
      const draftBody = originalMail.body_html || originalMail.body_text;
      if (draftBody) {
        content = draftBody;
      } else {
        // Body not loaded yet (header-only sync) — fetch it
        content = "<p></p>";
        fetchMailBody(originalMail.id)
          .then((updated) => {
            if (cancelled) return;
            const body = updated.body_html || updated.body_text || "";
            if (body && editor) {
              editor.commands.setContent(body);
            }
          })
          .catch(() => {});
      }
    } else if (mode === "new") {
      if (mailtoParams) {
        setTo(mailtoParams.to);
        setCc(mailtoParams.cc);
        setBcc(mailtoParams.bcc);
        setSubject(mailtoParams.subject);
        setShowCc(mailtoParams.cc.length > 0);
        setShowBcc(mailtoParams.bcc.length > 0);
        const bodyHtml = mailtoParams.body ? `<p>${mailtoParams.body.replace(/\n/g, "<br>")}</p>` : "<p></p>";
        content = `${bodyHtml}${signature}`;
      } else {
        setTo([]);
        setCc([]);
        setBcc([]);
        setSubject("");
        setShowCc(false);
        setShowBcc(false);
        content = `<p></p>${signature}`;
      }
      setAttachments([]);
    } else if (originalMail) {
      if (mode === "reply") {
        const replyTarget = originalMail.reply_to?.length > 0 ? originalMail.reply_to[0] : originalMail.from;
        const fromFormatted = formatAddress(replyTarget);
        setTo(fromFormatted ? [fromFormatted] : []);
        setCc([]);
        setSubject(generateReplySubject(originalMail.subject));
        setQuotedHtml(generateReplyBodyHtml(originalMail));
        if (composeAiReplyText) {
          const aiHtml = `<p>${composeAiReplyText.replace(/\n/g, '<br>')}</p>`;
          content = `${aiHtml}${signature}`;
        } else {
          content = `<p></p>${signature}`;
        }
      } else if (mode === "replyAll") {
        const replyTarget = originalMail.reply_to?.length > 0 ? originalMail.reply_to[0] : originalMail.from;
        const fromFormatted = formatAddress(replyTarget);
        setTo(fromFormatted ? [fromFormatted] : []);
        const ownEmail = accounts?.find((a) => a.id === defaultAccountId)?.email?.toLowerCase();
        // Email addresses are case-insensitive (RFC 5321); drop our own address from
        // both To and Cc so reply-all never includes the sender.
        const notSelf = (r: { email: string }) => !ownEmail || r.email.toLowerCase() !== ownEmail;
        const ccRecipients = [
          ...originalMail.to.filter(notSelf),
          ...originalMail.cc.filter(notSelf),
        ];
        const ccFormatted = ccRecipients.map((r) => formatAddress(r)).filter((v): v is string => v !== null);
        setCc(ccFormatted);
        setShowCc(ccFormatted.length > 0);
        setSubject(generateReplySubject(originalMail.subject));
        setQuotedHtml(generateReplyBodyHtml(originalMail));
        if (composeAiReplyText) {
          const aiHtml = `<p>${composeAiReplyText.replace(/\n/g, '<br>')}</p>`;
          content = `${aiHtml}${signature}`;
        } else {
          content = `<p></p>${signature}`;
        }
      } else if (mode === "forward") {
        setTo([]);
        setCc([]);
        setSubject(generateForwardSubject(originalMail.subject));
        setQuotedHtml(generateForwardBodyHtml(originalMail));
        content = `<p></p>${signature}`;

        if (originalMail.has_attachments) {
          void loadAttachmentsFrom(originalMail.id);
        }
      }
    }

    editor.commands.setContent(content);

    // Fallback: if reply/forward originalMail has no body, fetch it and update editor
    if (originalMail && (mode === "reply" || mode === "replyAll" || mode === "forward") && !originalMail.body_html && !originalMail.body_text) {
      fetchMailBody(originalMail.id)
        .then((updated) => {
          if (cancelled) return;
          if (!editor || !(updated.body_html || updated.body_text)) return;
          const isReply = mode === "reply" || mode === "replyAll";
          const sig = getSignatureHtml(defaultAccountId, true);
          if (isReply) {
            setQuotedHtml(generateReplyBodyHtml(updated));
            if (composeAiReplyText) {
              const aiHtml = `<p>${composeAiReplyText.replace(/\n/g, '<br>')}</p>`;
              editor.commands.setContent(`${aiHtml}${sig}`);
            } else {
              editor.commands.setContent(`<p></p>${sig}`);
            }
          } else {
            setQuotedHtml(generateForwardBodyHtml(updated));
            editor.commands.setContent(`<p></p>${sig}`);
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [isOpen, mode, originalMail, accounts, selectedAccountId, editor, getSignatureHtml, mailtoParams, composeAiReplyText]);

  useEffect(() => {
    if (!isOpen || !editor) return;
    // For new mails without pre-filled recipients, RecipientInput handles focus.
    // For reply/forward/draft, focus the editor so user can start typing immediately.
    const shouldFocusEditor = mode !== "new" || to.length > 0;
    if (shouldFocusEditor) {
      const timer = setTimeout(() => {
        editor.commands.focus("start");
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [isOpen, editor, mode, to.length]);

  // Restore compose state when undo-send is cancelled
  const restoreSnapshot = initData?.snapshot ?? undoSendSnapshot;
  useEffect(() => {
    if (!isOpen || !editor || !restoreSnapshot) return;
    setTo(restoreSnapshot.to);
    setCc(restoreSnapshot.cc);
    setBcc(restoreSnapshot.bcc);
    setShowCc(restoreSnapshot.cc.length > 0);
    setShowBcc(restoreSnapshot.bcc.length > 0);
    setSubject(restoreSnapshot.subject);
    setFromAccountId(restoreSnapshot.fromAccountId);
    setAttachments(restoreSnapshot.attachments);
    setQuotedHtml(restoreSnapshot.quotedHtml || "");
    editor.commands.setContent(restoreSnapshot.bodyHtml);
    // Clear snapshot so it doesn't re-apply
    useAppStore.getState().clearUndoSend();
  }, [isOpen, editor, restoreSnapshot]);

  useEffect(() => {
    if (!aiRequestId) return;
    const unlisten = listen<AiRepliesEvent>("ai-replies", (event) => {
      const data = event.payload;
      if (data.request_id !== aiRequestId) return;
      if (data.replies && data.replies.length > 0) setAiReplies(data.replies);
      setAiLoading(false);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [aiRequestId]);

  useEffect(() => {
    if (!isOpen) {
      setAiReplies([]);
      setAiLoading(false);
      setAiRequestId(null);
      setShowTemplateMenu(false);
    }
  }, [isOpen]);

  // Tick every 15 s so "Saved X ago" label refreshes
  useEffect(() => {
    if (!lastSavedAt) return;
    const id = setInterval(() => setRelativeTick((n) => n + 1), 15_000);
    return () => clearInterval(id);
  }, [lastSavedAt]);

  useEffect(() => {
    if (isOpen && hasFeature("templates")) {
      listTemplates().then(setTemplates).catch(() => {});
    }
  }, [isOpen, hasFeature]);

  async function handleAiSuggest() {
    if (!originalMail) return;
    setAiReplies([]);
    setAiLoading(true);
    try {
      const result = await suggestReplies(originalMail.id);
      if (result.cached_text) {
        try {
          const parsed = JSON.parse(result.cached_text) as ReplySuggestion[];
          setAiReplies(parsed);
        } catch { /* ignore parse errors */ }
        setAiLoading(false);
      } else {
        setAiRequestId(result.request_id);
      }
    } catch {
      setAiLoading(false);
    }
  }

  function handleUseAiReply(text: string) {
    if (!editor) return;
    const aiHtml = `<p>${text.replace(/\n/g, '<br>')}</p>`;
    const signature = getSignatureHtml(fromAccountId, true);
    if (originalMail) {
      setQuotedHtml(generateReplyBodyHtml(originalMail));
    }

    editor.commands.setContent(aiHtml + signature);
    setAiReplies([]);
    editor.commands.focus("start");
  }

  function handleApplyTemplate(template: EmailTemplate) {
    if (!editor) return;
    if (template.subject) setSubject(template.subject);
    // Prefer body_text (the panel's source of truth), escaped here — templates
    // saved before the escaping fix carry broken unescaped body_html.
    const bodyContent = template.body_text
      ? `<p>${escapeHtml(template.body_text).replace(/\n/g, "<br>")}</p>`
      : template.body_html;
    const signature = getSignatureHtml(fromAccountId, false);
    editor.commands.setContent(bodyContent + signature);
    setShowTemplateMenu(false);
    editor.commands.focus("start");
  }

  function handleFromChange(newAccountId: string) {
    const oldAccountId = fromAccountId;
    setFromAccountId(newAccountId);
    if (!editor || oldAccountId === newAccountId || mode === "draft") return;

    const isReplyOrForward = mode === "reply" || mode === "replyAll" || mode === "forward";
    const newSig = getSignatureHtml(newAccountId, isReplyOrForward);

    const html = editor.getHTML();
    const sigRegex = /<div data-type="signature">[\s\S]*?<\/div>/;

    if (sigRegex.test(html)) {
      editor.commands.setContent(html.replace(sigRegex, newSig));
    } else if (newSig) {
      editor.commands.setContent(html + newSig);
    }
  }

  function addFiles(files: FileList | File[]) {
    Array.from(files).forEach((file) => {
      if (file.size > 25 * 1024 * 1024) {
        setSendError(t("compose.fileTooLarge", { name: file.name }));
        addToast("error", t("compose.fileTooLarge", { name: file.name }));
        return;
      }

      if (attachments.some((a) => a.name === file.name && a.size === file.size)) {
        addToast("warning", t("compose.fileAlreadyAttached", { name: file.name }));
        return;
      }

      const reader = new FileReader();
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        setAttachments((prev) => [
          ...prev,
          {
            name: file.name,
            size: file.size,
            type: file.type || "application/octet-stream",
            data: base64,
          },
        ]);
      };
      reader.readAsDataURL(file);
    });
  }

  function handleAttachFiles(e: React.ChangeEvent<HTMLInputElement>) {
    const files = e.target.files;
    if (!files) return;
    addFiles(files);

    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  }

  function isFileDrag(e: React.DragEvent) {
    return e.dataTransfer.types.includes("Files");
  }

  function handleDragEnter(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current++;
    setIsDragging(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    dragCounter.current--;
    if (dragCounter.current === 0) {
      setIsDragging(false);
    }
  }

  function handleDragOver(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
  }

  function handleDrop(e: React.DragEvent) {
    if (!isFileDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
    dragCounter.current = 0;

    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      addFiles(files);
    }
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  // Build the outgoing body from the editor + quoted reply. We send the editor's
  // raw HTML: TipTap's schema only permits a safe set of nodes/marks (pasted
  // scripts/handlers are dropped on input), and crucially we must keep real
  // `href`s so links work in the recipient's client — the display sanitizer
  // rewrites href→data-href for our iframe and would break outgoing links.
  function buildOutgoingBody(): { bodyHtml: string; bodyText: string } {
    if (!editor) return { bodyHtml: quotedHtml, bodyText: "" };
    const editorHtml = editor.getHTML();
    const editorText = editor.getText({ blockSeparator: '\n\n' });
    const bodyHtml = editorHtml + quotedHtml;
    const bodyText = editorText + (quotedHtml ? "\n\n" + quotedHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "");
    return { bodyHtml, bodyText };
  }

  function formatFileSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  async function handleSend(): Promise<boolean> {
    const pendingTo = toFieldRef.current?.commitPending() ?? null;
    const pendingCc = ccFieldRef.current?.commitPending() ?? null;
    const pendingBcc = bccFieldRef.current?.commitPending() ?? null;
    const effTo = pendingTo ? [...to, pendingTo] : to;
    const effCc = pendingCc ? [...cc, pendingCc] : cc;
    const effBcc = pendingBcc ? [...bcc, pendingBcc] : bcc;

    if (effTo.length === 0) {
      setSendError(t("compose.enterRecipient"));
      return false;
    }

    if (!fromAccountId) {
      setSendError(t("compose.selectAccount"));
      return false;
    }

    if (!editor) return false;

    setSendError(null);

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const allChips = [...effTo, ...effCc, ...effBcc];
    for (const chip of allChips) {
      const parsed = parseRecipients(chip);
      const invalid = parsed.find((r) => !emailRegex.test(r.email));
      if (invalid) {
        setSendError(t("compose.invalidEmail", { email: invalid.email }));
        return false;
      }
    }

    if (!subject.trim()) {
      const confirmed = await dialog.confirm({
        title: t("compose.noSubjectTitle"),
        message: t("compose.noSubjectMessage"),
        confirmLabel: t("compose.sendWithoutSubject"),
      });
      if (!confirmed) return false;
    }

    const recipientCount = [...effTo, ...effCc, ...effBcc].reduce(
      (n, chip) => n + parseRecipients(chip).length, 0,
    );
    if (recipientCount > 10) {
      const ok = await dialog.confirm({
        title: t("compose.manyRecipientsTitle"),
        message: t("compose.manyRecipientsMessage", { count: recipientCount }),
      });
      if (!ok) return false;
    }

    const { bodyHtml, bodyText } = buildOutgoingBody();

    const request: SendMailRequest = {
      account_id: fromAccountId,
      to: effTo,
      cc: effCc,
      bcc: effBcc,
      subject: subject || t("compose.noSubject"),
      body_text: bodyText,
      body_html: bodyHtml,
      in_reply_to: originalMail?.message_id || undefined,
      references: buildReferencesChain(originalMail),
      attachments: attachments.map((att) => ({
        name: att.name,
        mime_type: att.type,
        data: att.data,
      })),
    };

    const snapshot: ComposeSnapshot = {
      to: [...effTo],
      cc: [...effCc],
      bcc: [...effBcc],
      subject,
      bodyHtml,
      bodyText,
      fromAccountId,
      attachments: attachments.map((att) => ({ ...att })),
      quotedHtml: quotedHtml || undefined,
    };

    if (appSettings.undo_send_delay === 0) {
      // Undo-send disabled — send directly
      setSending(true);
      sendMail(request).then(async () => {
        // Sent from a saved draft — remove the original draft (moves it to Trash).
        // Awaited before the sync: the cleanup queues the server-side move as a pending
        // op, which the sync runs before re-fetching folders. Syncing first lets it
        // re-import the draft that is still in the server's Drafts folder.
        if (mode === "draft" && originalMail) {
          await trashMail(originalMail.id).catch((err) => {
            console.error("draft cleanup after send failed", err);
          });
        }
        emit("mails-changed", { account_id: request.account_id });
        syncAccount(request.account_id).catch(() => {});
        onClose();
      }).catch((err) => {
        setSendError(err instanceof Error ? err.message : String(err));
      }).finally(() => setSending(false));
    } else if (initData) {
      // Compose window mode — emit to main window for undo-send, then close
      emit("undo-send-start", { request, mode, originalMail: originalMail ?? null, snapshot });
      onClose();
    } else {
      startUndoSend(request, mode, originalMail ?? null, snapshot);
    }

    return true;
  }

  // Keep a ref to the latest handleSend so the global key listener never calls a
  // stale closure (handleSend closes over recipients/body/subject each render).
  const handleSendRef = useRef(handleSend);
  handleSendRef.current = handleSend;
  const handleDiscardRef = useRef<() => void>(() => {});
  // Guard ref: true when any dialog is open on top of the compose form (DialogProvider
  // confirm dialogs, the compose's own discard dialog, or the link-insert dialog).
  // Updated every render so the capture-once useEffect([]) listener is never stale.
  const escBlockedRef = useRef(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        if (escBlockedRef.current) return;
        e.preventDefault();
        handleDiscardRef.current();
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleSendRef.current();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, []);

  function getSchedulePresets(): { label: string; date: Date }[] {
    const now = new Date();
    const tomorrow9 = new Date(now);
    tomorrow9.setDate(tomorrow9.getDate() + 1);
    tomorrow9.setHours(9, 0, 0, 0);

    const nextMonday9 = new Date(now);
    const daysUntilMonday = ((8 - now.getDay()) % 7) || 7;
    nextMonday9.setDate(nextMonday9.getDate() + daysUntilMonday);
    nextMonday9.setHours(9, 0, 0, 0);

    const in2hours = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    return [
      { label: t("scheduled.in2hours"), date: in2hours },
      { label: t("scheduled.tomorrow9"), date: tomorrow9 },
      { label: t("scheduled.nextMonday9"), date: nextMonday9 },
    ];
  }

  async function handleScheduleSend(scheduledDate: Date) {
    const pendingTo = toFieldRef.current?.commitPending() ?? null;
    const pendingCc = ccFieldRef.current?.commitPending() ?? null;
    const pendingBcc = bccFieldRef.current?.commitPending() ?? null;
    const effTo = pendingTo ? [...to, pendingTo] : to;
    const effCc = pendingCc ? [...cc, pendingCc] : cc;
    const effBcc = pendingBcc ? [...bcc, pendingBcc] : bcc;

    if (effTo.length === 0 || !fromAccountId || !editor) return;

    setSendError(null);

    // Guard against a past schedule time (e.g. typed past the picker's min).
    if (isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
      setSendError(t("compose.scheduledInPast"));
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const allChips = [...effTo, ...effCc, ...effBcc];
    for (const chip of allChips) {
      const parsed = parseRecipients(chip);
      const invalid = parsed.find((r) => !emailRegex.test(r.email));
      if (invalid) {
        setSendError(t("compose.invalidEmail", { email: invalid.email }));
        return;
      }
    }

    if (!subject.trim()) {
      const confirmed = await dialog.confirm({
        title: t("compose.noSubjectTitle"),
        message: t("compose.noSubjectMessage"),
        confirmLabel: t("compose.sendWithoutSubject"),
      });
      if (!confirmed) return;
    }

    const { bodyHtml, bodyText } = buildOutgoingBody();

    const request: SendMailRequest = {
      account_id: fromAccountId,
      to: effTo,
      cc: effCc,
      bcc: effBcc,
      subject: subject || t("compose.noSubject"),
      body_text: bodyText,
      body_html: bodyHtml,
      in_reply_to: originalMail?.message_id || undefined,
      references: buildReferencesChain(originalMail),
      attachments: attachments.map((att) => ({
        name: att.name,
        mime_type: att.type,
        data: att.data,
      })),
    };

    setSending(true);
    setShowScheduleMenu(false);
    const isoDate = scheduledDate.toISOString().replace("T", " ").replace("Z", "");
    scheduleSend(request, isoDate)
      .then(() => onClose())
      .catch((err) => setSendError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSending(false));
  }

  function handleScheduleCustom() {
    setShowScheduleMenu(false);
    // Use native datetime-local input via a hidden element
    const input = document.createElement("input");
    input.type = "datetime-local";
    input.min = new Date().toISOString().slice(0, 16);
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.showPicker?.();
    input.addEventListener("change", () => {
      const val = input.value;
      if (val) handleScheduleSend(new Date(val));
      document.body.removeChild(input);
    });
    input.addEventListener("blur", () => {
      setTimeout(() => { if (document.body.contains(input)) document.body.removeChild(input); }, 200);
    });
  }

  const dialog = useDialog();
  // Keep escBlockedRef current every render so the capture-once keydown listener
  // can check it without a stale closure.
  escBlockedRef.current = showDiscardDialog || linkDialogOpen || dialog.isOpen;

  function handleDiscardClick() {
    const hasContent = editor ? editor.getText().trim().length > 0 : false;
    if (hasContent || subject.trim() || to.length > 0 || attachments.length > 0) {
      setShowDiscardDialog(true);
    } else {
      onClose();
    }
  }
  handleDiscardRef.current = handleDiscardClick;

  // Expose requestClose so ComposeWindow can trigger the discard check
  useImperativeHandle(ref, () => ({ requestClose: handleDiscardClick }), [editor, subject, to, attachments]);

  async function handleSaveDraft() {
    if (!fromAccountId || !editor) return;

    setSavingDraft(true);
    setShowDiscardDialog(false);

    try {
      const editorHtml = editor.getHTML();
      const editorText = editor.getText({ blockSeparator: '\n\n' });
      const bodyHtml = editorHtml + quotedHtml;
      const bodyText = editorText + (quotedHtml ? "\n\n" + quotedHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "");

      const request: SendMailRequest = {
        account_id: fromAccountId,
        to,
        cc,
        bcc,
        subject: subject || t("compose.noSubject"),
        body_text: bodyText,
        body_html: bodyHtml,
        in_reply_to: originalMail?.message_id || undefined,
        references: buildReferencesChain(originalMail),
        attachments: attachments.map((att) => ({
          name: att.name,
          mime_type: att.type,
          data: att.data,
        })),
      };

      const savedMailId = await saveDraft(request);
      // Editing an existing draft saves a new one — drop the superseded version.
      if (mode === "draft" && originalMail) {
        await trashMail(originalMail.id).catch((err) => {
          console.error("superseded draft cleanup failed", err);
        });
      }
      setLastSavedAt(new Date());
      // The draft is already in the local DB (IMAP) — refresh the list now so it can
      // be reopened without waiting for the sync round-trip. Emitted rather than
      // invalidated locally because compose may run in its own window.
      emit("mails-changed", { account_id: request.account_id, mail_id: savedMailId });
      // Reconcile with the server (claims the UID for the mirrored row).
      syncAccount(request.account_id).catch(() => {});
      onClose();
    } catch (err) {
      await dialog.alert({
        type: "danger",
        title: t("compose.saveError"),
        message: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setSavingDraft(false);
    }
  }

  function handleDiscardConfirm() {
    setShowDiscardDialog(false);
    onClose();
  }

  function handleDropToField(
    targetField: "to" | "cc" | "bcc",
    sourceField: "to" | "cc" | "bcc",
    recipient: string,
  ) {
    if (sourceField === targetField) return;
    const lists: Record<"to" | "cc" | "bcc", string[]> = { to, cc, bcc };
    const setters: Record<"to" | "cc" | "bcc", (next: string[]) => void> = {
      to: setTo,
      cc: setCc,
      bcc: setBcc,
    };
    setters[sourceField](lists[sourceField].filter((r) => r !== recipient));
    const target = lists[targetField];
    if (!target.includes(recipient)) {
      setters[targetField]([...target, recipient]);
    }
    if (targetField === "cc") setShowCc(true);
    if (targetField === "bcc") setShowBcc(true);
  }

  const modeTitle = mode === "new" ? t("compose.newMessage") : mode === "draft" ? t("compose.draft") : mode === "reply" ? t("compose.reply") : mode === "replyAll" ? t("compose.replyAll") : t("compose.forward");

  return (
    <>
      <div
        className="flex flex-col flex-1 min-h-0 relative"
        onDragEnter={handleDragEnter}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
      >
        <AnimatePresence>
          {isDragging && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-0 z-50 bg-accent/10 backdrop-blur-sm border-2 border-dashed border-accent rounded-xl flex flex-col items-center justify-center"
            >
              <motion.div
                initial={{ scale: 0.8 }}
                animate={{ scale: 1 }}
                className="w-20 h-20 rounded-full bg-accent/20 flex items-center justify-center mb-4"
              >
                <Paperclip className="w-10 h-10 text-accent" />
              </motion.div>
              <p className="text-lg font-medium text-accent">{t("compose.dropFiles")}</p>
              <p className="text-sm text-text-secondary mt-1">{t("compose.toAddAttachments")}</p>
            </motion.div>
          )}
        </AnimatePresence>

        <div ref={scrollRef} data-compose-scroll className="flex-1 overflow-y-auto">
          {accounts && accounts.length > 1 && (() => {
            const selected = accounts.find((a) => a.id === fromAccountId);
            return (
              <div className="flex items-center gap-3 px-5 py-2.5 border-b border-border-light">
                <GradientAvatar name={selected?.display_name} email={selected?.email ?? ""} size={28} />
                <div className="relative flex-1 min-w-0">
                  <select
                    value={fromAccountId}
                    onChange={(e) => handleFromChange(e.target.value)}
                    className="w-full appearance-none bg-transparent text-sm font-medium text-text cursor-pointer pr-6 truncate focus:outline-none"
                  >
                    {accounts.map((account) => (
                      <option key={account.id} value={account.id} className="bg-surface text-text">
                        {account.display_name} &lt;{account.email}&gt;
                      </option>
                    ))}
                  </select>
                  <ChevronDown className="w-4 h-4 text-text-tertiary absolute right-0 top-1/2 -translate-y-1/2 pointer-events-none" />
                </div>
              </div>
            );
          })()}

          <div className="flex items-start px-5 py-2 border-b border-border-light">
            <label className="w-16 text-sm text-text-tertiary shrink-0 pt-1.5">{t("compose.to")}</label>
            <RecipientInput
              ref={toFieldRef}
              recipients={to}
              onChange={setTo}
              placeholder="recipient@example.com"
              accountId={fromAccountId || undefined}
              autoFocus={mode === "new" && to.length === 0}
              fieldId="to"
              onChipDroppedFromField={(src, rec) => handleDropToField("to", src, rec)}
              blockedEmails={[...emailsOf(cc), ...emailsOf(bcc)]}
            />
            <div className="flex items-center gap-1 text-xs text-text-tertiary ml-2 pt-1.5">
              {!showCc && (
                <button tabIndex={-1} onClick={() => setShowCc(true)} className="hover:text-text transition-colors">
                  Cc
                </button>
              )}
              {!showBcc && (
                <button tabIndex={-1} onClick={() => setShowBcc(true)} className="hover:text-text transition-colors">
                  Bcc
                </button>
              )}
            </div>
          </div>

          {showCc && (
            <div className="flex items-start px-5 py-2 border-b border-border-light">
              <label className="w-16 text-sm text-text-tertiary shrink-0 pt-1.5">Cc</label>
              <RecipientInput
                ref={ccFieldRef}
                recipients={cc}
                onChange={setCc}
                placeholder="cc@example.com"
                accountId={fromAccountId || undefined}
                fieldId="cc"
                onChipDroppedFromField={(src, rec) => handleDropToField("cc", src, rec)}
                blockedEmails={[...emailsOf(to), ...emailsOf(bcc)]}
              />
            </div>
          )}

          {showBcc && (
            <div className="flex items-start px-5 py-2 border-b border-border-light">
              <label className="w-16 text-sm text-text-tertiary shrink-0 pt-1.5">Bcc</label>
              <RecipientInput
                ref={bccFieldRef}
                recipients={bcc}
                onChange={setBcc}
                placeholder="bcc@example.com"
                accountId={fromAccountId || undefined}
                fieldId="bcc"
                onChipDroppedFromField={(src, rec) => handleDropToField("bcc", src, rec)}
                blockedEmails={[...emailsOf(to), ...emailsOf(cc)]}
              />
            </div>
          )}

          <div className="flex items-center px-5 py-2 border-b border-border-light">
            <label className="w-16 text-sm text-text-tertiary shrink-0">{t("compose.subject")}</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("compose.subjectPlaceholder")}
              className="flex-1 bg-transparent text-sm text-text placeholder:text-text-secondary"
            />
          </div>

          <EditorToolbar editor={editor} linkDialogOpen={linkDialogOpen} setLinkDialogOpen={setLinkDialogOpen} />

          {aiReplies.length > 0 && (
            <div className="px-4 py-3 border-b border-border-light bg-accent/5">
              <div className="flex items-center gap-2 mb-2">
                <Sparkles className="w-3.5 h-3.5 text-accent" />
                <span className="text-xs font-semibold text-accent">{t("ai.suggestReply")}</span>
                <button onClick={() => setAiReplies([])} className="ml-auto p-1 rounded hover:bg-hover text-text-tertiary">
                  <X className="w-3 h-3" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {aiReplies.map((reply, i) => (
                  <button
                    key={i}
                    onClick={() => handleUseAiReply(reply.text)}
                    className="p-2.5 rounded-lg border border-border hover:border-accent/40 hover:bg-accent/5 text-left transition-colors"
                  >
                    <span className="text-[11px] font-semibold text-accent block mb-1">
                      {t(`ai.${reply.tone}`, reply.tone)}
                    </span>
                    <p className="text-xs text-text-secondary leading-relaxed line-clamp-3">
                      {reply.text}
                    </p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {aiLoading && (
            <div className="flex items-center gap-2 px-4 py-3 border-b border-border-light bg-accent/5">
              <Loader2 className="w-4 h-4 text-accent animate-spin" />
              <span className="text-xs text-text-tertiary">{t("ai.generatingReplies")}</span>
            </div>
          )}

          <div className="p-4 min-h-[250px] focus-within:bg-bg-secondary rounded-lg transition-colors">
            <EditorContent
              editor={editor}
              className="compose-editor text-sm text-text leading-relaxed"
            />
            {quotedHtml && (
              <div className="mt-2">
                <div className="flex items-center justify-between mb-1.5 text-xs text-text-tertiary">
                  <span>{i18n.t("compose.quotedMessage")}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (!editor) return;
                      const endPos = editor.state.doc.content.size;
                      editor.chain()
                        .insertContentAt(endPos, quotedHtml)
                        .focus("start")
                        .run();
                      setQuotedHtml("");
                    }}
                    className="flex items-center gap-1 px-2 py-1 rounded hover:bg-hover text-text-secondary hover:text-text transition-colors"
                  >
                    <Pencil className="w-3 h-3" />
                    <span>{i18n.t("compose.editQuote")}</span>
                  </button>
                </div>
                <div className="border-l-2 border-border pl-3">
                  <HtmlMailFrame html={quotedHtml} allowExternalImages={true} />
                </div>
              </div>
            )}
          </div>

          {attachments.length > 0 && (
            <div className="px-4 pb-4">
              <div className="flex items-center gap-2 mb-2">
                <Paperclip className="w-4 h-4 text-text-tertiary" />
                <span className="text-xs font-medium text-text-secondary">
                  {t("compose.attachment", { count: attachments.length })}
                </span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {attachments.map((att, index) => {
                  const FileIcon = getFileIcon(att.type, att.name);
                  const iconColor = getFileColor(att.type, att.name);
                  return (
                    <div
                      key={index}
                      className="group relative flex flex-col items-center p-3 rounded-lg bg-bg-secondary border border-border hover:border-border-light transition-colors"
                    >
                      <button
                        onClick={() => removeAttachment(index)}
                        className="absolute top-1 right-1 p-1 rounded-full bg-surface border border-border opacity-0 group-hover:opacity-100 hover:bg-danger hover:border-danger hover:text-white text-text-tertiary transition-all"
                      >
                        <X className="w-3 h-3" />
                      </button>
                      <div className={`w-10 h-10 rounded-lg bg-surface flex items-center justify-center mb-2 ${iconColor}`}>
                        <FileIcon className="w-6 h-6" />
                      </div>
                      <span className="text-xs text-text truncate w-full text-center font-medium">{att.name}</span>
                      <span className="text-[10px] text-text-tertiary">{formatFileSize(att.size)}</span>
                    </div>
                  );
                })}
              </div>
              {(() => {
                const totalBytes = attachments.reduce((s, a) => s + a.size, 0);
                const totalMB = totalBytes / 1024 / 1024;
                const tone = totalMB > 20 ? "danger" : totalMB > 15 ? "warning" : "normal";
                const colorClass = tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-text-tertiary";
                return (
                  <div className={`text-xs ${colorClass} mt-1`}>
                    {t("compose.attachmentsSize", { size: formatFileSize(totalBytes) })}
                    {tone !== "normal" && ` — ${t("compose.attachmentsSizeWarning")}`}
                  </div>
                );
              })()}
            </div>
          )}
        </div>

        <div className="border-t border-border bg-bg-secondary">
          {sendError && (
            <div className="px-4 py-2 bg-danger/10 text-danger text-sm">
              {sendError}
            </div>
          )}
          <div className="flex items-center justify-between px-4 py-3">
            <div className="flex items-center gap-1">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                onChange={handleAttachFiles}
                className="hidden"
              />
              <IconButton
                icon={<Paperclip />}
                aria-label={t("compose.attachFile")}
                onClick={() => fileInputRef.current?.click()}
              />
              <IconButton
                icon={<Trash2 />}
                aria-label={t("compose.discard")}
                onClick={handleDiscardClick}
                className="hover:text-danger"
              />
              {appSettings.ai_enabled && originalMail && (mode === "reply" || mode === "replyAll") && (
                <IconButton
                  icon={aiLoading ? <Loader2 className="animate-spin" /> : <Sparkles />}
                  aria-label={t("ai.suggestReply")}
                  onClick={handleAiSuggest}
                  disabled={aiLoading}
                  className={aiReplies.length > 0 ? "text-accent" : ""}
                />
              )}
              {hasFeature("templates") && templates.length > 0 && (
                <div className="relative" ref={templateBtnRef}>
                  <IconButton
                    icon={<FileType />}
                    aria-label={t("templates.insertTemplate")}
                    onClick={() => setShowTemplateMenu(!showTemplateMenu)}
                    className={showTemplateMenu ? "text-accent" : ""}
                  />
                  {showTemplateMenu && (
                    <div className="absolute bottom-full left-0 mb-2 min-w-[200px] max-w-[280px] bg-surface rounded-lg shadow-lg border border-border py-1 z-50">
                      <div className="px-3 py-1.5 text-xs font-semibold text-text-tertiary">{t("templates.insertTemplate")}</div>
                      {templates.map((tpl) => (
                        <button
                          key={tpl.id}
                          onClick={() => handleApplyTemplate(tpl)}
                          className="w-full text-left px-3 py-1.5 text-sm text-text hover:bg-hover transition-colors truncate"
                        >
                          {tpl.name}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-text-tertiary select-none">
              {savingDraft ? (
                <>
                  <PulseDot color="var(--c-warning)" size={6} ringCount={1} />
                  <span>{t("compose.saving")}</span>
                </>
              ) : lastSavedAt ? (
                <>
                  <PulseDot color="var(--c-success)" size={6} ringCount={0} />
                  <span>{t("compose.savedAgo", { time: formatDistanceToNowStrict(lastSavedAt, { addSuffix: true }) })}</span>
                </>
              ) : null}
            </div>
            <div
              ref={scheduleBtnRef}
              className="relative flex items-stretch gap-0 rounded-xl [box-shadow:0_2px_8px_rgba(59,130,246,0.25)]"
            >
              <SendButton onSend={handleSend} disabled={to.length === 0} />
              <button
                onClick={() => setShowScheduleMenu(!showScheduleMenu)}
                disabled={to.length === 0 || sending}
                className="flex items-center px-2 bg-accent text-white rounded-r-xl border-l border-white/20 disabled:opacity-50 transition-[filter] duration-200 hover:brightness-110 active:brightness-95"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
              {showScheduleMenu && (
                <div className="absolute bottom-full right-0 mb-2 min-w-[200px] bg-surface rounded-lg shadow-lg border border-border py-1 z-50">
                  <div className="px-3 py-1.5 text-xs font-semibold text-text-tertiary flex items-center gap-1.5">
                    <CalendarClock className="w-3.5 h-3.5" />
                    {t("scheduled.scheduleSend")}
                  </div>
                  {getSchedulePresets().map((preset) => (
                    <button
                      key={preset.label}
                      onClick={() => handleScheduleSend(preset.date)}
                      className="w-full text-left px-3 py-1.5 text-sm text-text hover:bg-hover transition-colors"
                    >
                      {preset.label}
                    </button>
                  ))}
                  <div className="border-t border-border my-1" />
                  <button
                    onClick={handleScheduleCustom}
                    className="w-full text-left px-3 py-1.5 text-sm text-text hover:bg-hover transition-colors"
                  >
                    {t("scheduled.customTime")}
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {showDiscardDialog && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-60 flex items-center justify-center modal-backdrop"
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="bg-surface rounded-xl shadow-lg w-full max-w-sm overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-border bg-bg-secondary">
              <h3 className="text-sm font-semibold text-text">{t("compose.saveDraftTitle")}</h3>
            </div>
            <div className="p-4">
              <p className="text-sm text-text-secondary mb-4">
                {t("compose.saveDraftMessage")}
              </p>
              <div className="flex flex-col gap-2">
                <button
                  onClick={handleSaveDraft}
                  disabled={savingDraft}
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 transition-colors flex items-center justify-center gap-2"
                >
                  {savingDraft ? (
                    <>
                      <svg className="animate-spin w-4 h-4" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      {t("compose.saving")}
                    </>
                  ) : (
                    t("compose.saveDraft")
                  )}
                </button>
                <button
                  onClick={handleDiscardConfirm}
                  disabled={savingDraft}
                  className="w-full px-4 py-2.5 rounded-lg text-sm font-medium text-danger hover:bg-danger/10 transition-colors"
                >
                  {t("compose.discardMessage")}
                </button>
                <button
                  onClick={() => setShowDiscardDialog(false)}
                  disabled={savingDraft}
                  className="w-full px-4 py-2.5 rounded-lg text-sm text-text-secondary hover:bg-hover transition-colors"
                >
                  {t("compose.keepEditing")}
                </button>
              </div>
            </div>
          </motion.div>
        </motion.div>
      )}
    </>
  );
});

interface ComposeModalProps {
  isOpen: boolean;
  onClose: () => void;
  mode: ComposeMode;
  originalMail?: Mail | null;
}

export function ComposeModal({ isOpen, onClose, mode, originalMail }: ComposeModalProps) {
  const { t } = useTranslation();
  const modeTitle = mode === "new" ? t("compose.newMessage") : mode === "draft" ? t("compose.draft") : mode === "reply" ? t("compose.reply") : mode === "replyAll" ? t("compose.replyAll") : t("compose.forward");
  const formRef = useRef<ComposeFormHandle>(null);
  // Route closing (X button, backdrop, Esc) through the form so unsaved work
  // triggers the save/discard dialog instead of being lost.
  const handleRequestClose = () => {
    if (formRef.current) formRef.current.requestClose();
    else onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop"
          onClick={(e) => e.target === e.currentTarget && handleRequestClose()}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 20 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 20 }}
            transition={{ duration: 0.2, ease: "easeOut" }}
            className="w-full max-w-3xl bg-surface rounded-xl shadow-lg overflow-hidden flex flex-col max-h-[90vh]"
          >
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary">
              <h2 className="text-sm font-semibold text-text">{modeTitle}</h2>
              <button
                onClick={handleRequestClose}
                className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <ComposeForm
              ref={formRef}
              isOpen={isOpen}
              onClose={onClose}
              mode={mode}
              originalMail={originalMail}
            />
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
