import { useState, useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from "react";
import type { ReactNode } from "react";
import { format, formatDistanceToNowStrict } from "date-fns";
import { dateLocale } from "../../lib/dateUtils";
import { PulseDot } from "../motion/PulseDot";
import { GradientAvatar } from "../motion/GradientAvatar";
import { SPRING_SNAPPY } from "../motion/tokens";
import { X, Paperclip, Trash2, Send, File, FileText, Image, Film, Music, FileCode, FileSpreadsheet, Archive, Sparkles, Loader2, FileType, CalendarClock, ChevronDown, Undo2, Check, Eye } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { EditorContent } from "@tiptap/react";
import TiptapImage from "@tiptap/extension-image";
import { useRichTextEditor } from "../editor/RichTextEditor";
import { hasOwnText, setComposeBody } from "./composeBody";
import { needsAttachmentReminder } from "./attachmentReminder";
import { EditorToolbar } from "../editor/EditorToolbar";
import { useTranslation } from "react-i18next";
import i18n from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import type { ComposeSnapshot } from "../../stores/appStore";
import { isMacOS } from "../../lib/platform";
import { useAccounts } from "../../hooks/useAccounts";
import { useScroller } from "../../hooks/useScroller";
import { useDialog } from "../ui/DialogProvider";
import { Button, IconButton } from "../ui/Button";
import { DateField } from "../ui/DateField";
import { Select } from "../ui/Select";
import { TimeField } from "../ui/TimeField";
import { isoDate } from "../../lib/calendar/dates";
import { listen, emit } from "@tauri-apps/api/event";
import { saveDraft, syncAccount, fetchMailBody, suggestReplies, sendMail, scheduleSend, listTemplates, listAttachments, getAttachmentData, trashMail, saveComposeAutosave } from "../../lib/tauri";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { AiRepliesEvent, EmailTemplate, ReplySuggestion } from "../../types";
import { escapeHtml, restoreSanitizedHtml } from "../../lib/sanitize";
import { QUOTE_EDIT_ROOT, bodyWithoutQuote, buildQuote, quoteFromHtml, renderQuote, splitQuote, stripQuoteMarker, type ComposeQuote } from "../../lib/composeQuote";
import { fillEmptyParagraphs, inlineComposeStyles, addSignatureDivider, composeTypography, extractLocalImages, extractDataImages, dropImagesByCid } from "../../lib/outgoingHtml";
import { base64Size } from "../../lib/imagePrep";
import { currentAccentHex } from "../../lib/accents";
import { SignatureNode } from "./signatureNode";
import { MANY_RECIPIENTS, countRecipients, sendBlocker } from "./sendChecks";
import { resolveInlineImagesInHtml } from "../../lib/inlineImages";
import { stripMmlTags } from "../../lib/missingParts";
import { QuoteCard } from "./QuoteCard";
import { RecipientInput, type RecipientInputHandle } from "./RecipientInput";
import { ComposePreview, type ComposePreviewData } from "./ComposePreview";
import type { Mail, SendMailRequest, SendAttachment, Attachment, Account, AppSettings } from "../../types";
import { formatFileSize } from "../../lib/fileSize";
import { prepareImage } from "../../lib/imagePrep";
import { FilePaste, displayWidth } from "./pasteFiles";
import type { SortedPaste } from "./pasteFiles";
import {
  MAX_ATTACHMENT_BYTES,
  toOriginal,
  tooLargeToRead,
  withPrepared,
  type ImageNotes,
} from "./attachmentImages";

interface AttachmentFile extends ImageNotes {
  id: string;
  source?: { name: string; size: number }; // as picked, for the duplicate check
  name: string;
  size: number;
  type: string;
  data: string; // base64 — empty until status is "ready"
  // An attachment may only leave the composer once its bytes are actually here.
  // Anything else blocks the send: a mail without the file the user attached is
  // worse than one that refuses to go out.
  status: "loading" | "ready" | "failed";
  error?: string;
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

export type ComposeMode = "new" | "reply" | "replyAll" | "forward" | "draft";

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

function plainTextToQuotedHtml(text: string): string {
  // An MML placeholder the sender's client never turned into a MIME part is
  // not content: quoting it carries their local paths onward, nothing else.
  const normalized = stripMmlTags(text.replace(/\r\n/g, "\n").replace(/\r/g, "\n"));
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

/**
 * Turn the images in outgoing HTML into cid: inline attachments: `file://`
 * references (quoted signature logos etc.) and `data:` images (pasted pictures,
 * the signature logo). Sending local paths leaked the machine's filesystem
 * layout and arrived as broken images; data: URIs are not shown by many clients.
 */
async function embedInlineImages(
  bodyHtml: string,
  originalMail: Mail | null,
): Promise<{ html: string; inlineAttachments: SendAttachment[] }> {
  const local = await resolveLocalInlineImages(bodyHtml, originalMail);
  const { html, images } = extractDataImages(local.html);
  const inlineAttachments = [...local.inlineAttachments];
  for (const img of images) {
    inlineAttachments.push({
      name: img.name,
      mime_type: img.type,
      data: img.data,
      size: base64Size(img.data),
      content_id: img.cid,
    });
  }
  return { html, inlineAttachments };
}

async function resolveLocalInlineImages(
  bodyHtml: string,
  originalMail: Mail | null,
): Promise<{ html: string; inlineAttachments: SendAttachment[] }> {
  const { html, images } = extractLocalImages(bodyHtml);
  if (images.length === 0) return { html: bodyHtml, inlineAttachments: [] };

  const normalize = (p: string) => p.replace(/\//g, "\\").toLowerCase();
  const stored = originalMail
    ? await listAttachments(originalMail.id).catch(() => [] as Attachment[])
    : [];
  const byPath = new Map(
    stored.filter((a) => a.local_path).map((a) => [normalize(a.local_path!), a])
  );

  const inlineAttachments: SendAttachment[] = [];
  const unresolved: string[] = [];
  for (const ref of images) {
    const att = byPath.get(normalize(ref.path));
    if (!att) {
      unresolved.push(ref.cid);
      continue;
    }
    try {
      const payload = await getAttachmentData(att.id);
      inlineAttachments.push({
        name: payload.name,
        mime_type: payload.mime_type,
        data: payload.data,
        size: payload.size,
        content_id: ref.cid,
      });
    } catch {
      unresolved.push(ref.cid);
    }
  }

  // A reference we cannot back with a file must not go out at all — a dangling
  // cid: renders as a broken image, a file:// path leaks the local disk.
  return { html: dropImagesByCid(html, unresolved), inlineAttachments };
}

/** Inline-image references the fetcher could not rewrite, resolved against the
 *  stored attachments or dropped. Null when the body needs no work. */
async function withResolvedInlineImages(mail: Mail): Promise<Mail | null> {
  const html = mail.body_html ?? "";
  if (!/cid:|blob:|Attachment\//.test(html)) return null;
  const stored = await listAttachments(mail.id).catch(() => [] as Attachment[]);
  const body_html = resolveInlineImagesInHtml(html, stored);
  return body_html === html ? null : { ...mail, body_html };
}

function quoteFromMail(kind: "reply" | "forward", mail: Mail): ComposeQuote {
  const body = mail.body_html
    ? cleanEmailHtml(mail.body_html)
    : plainTextToQuotedHtml(mail.body_text || "");
  return buildQuote(kind, mail, body);
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

interface CustomSchedule {
  date: string;
  time: string;
}

function CustomScheduleForm({ value, onChange, onBack, onSchedule }: {
  value: CustomSchedule;
  onChange: (value: CustomSchedule) => void;
  onBack: () => void;
  onSchedule: (at: Date) => void;
}) {
  const { t } = useTranslation();
  const at = new Date(`${value.date}T${value.time}`);
  const inFuture = at.getTime() > Date.now();
  return (
    <div className="w-72 space-y-2 px-3 pt-1 pb-2">
      <DateField value={value.date} min={isoDate(new Date())} onChange={(date) => onChange({ ...value, date })} ariaLabel={t("scheduled.scheduleSend")} />
      <TimeField value={value.time} onChange={(time) => onChange({ ...value, time })} ariaLabel={t("scheduled.scheduleSend")} className="w-full" />
      <div className="flex items-center justify-between pt-1">
        <button type="button" onClick={onBack} className="py-1 text-xs text-text-secondary transition-colors hover:text-text">
          {t("common.back")}
        </button>
        <button
          type="button"
          disabled={!inFuture}
          onClick={() => { if (at.getTime() > Date.now()) onSchedule(at); }}
          className="py-1 text-xs font-semibold text-accent transition-colors hover:text-accent-hover disabled:opacity-40"
        >
          {t("scheduled.schedule")}
        </button>
      </div>
    </div>
  );
}

function SendButton({ onSend, disabled, onPhaseChange }: { onSend: () => Promise<boolean>; disabled: boolean; onPhaseChange: (phase: SendPhase) => void }) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<SendPhase>("idle");

  useEffect(() => {
    onPhaseChange(phase);
  }, [phase, onPhaseChange]);

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
    <button
      onClick={handleClick}
      disabled={disabled || phase !== "idle"}
      className="relative px-5 py-2 rounded-l-control text-on-accent font-semibold text-sm min-w-25 disabled:cursor-default"
    >
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
    </button>
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
  const typography = composeTypography(appSettings.compose_font, appSettings.compose_font_size);

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
  // Typed-but-not-chipped text in the To field still counts as a recipient
  // (handleSend commits it), so it must not leave the send button greyed out.
  const [toHasPending, setToHasPending] = useState(false);
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
  const [sendPhase, setSendPhase] = useState<SendPhase>("idle");
  // Bumped when a send fails after the button already showed "sent"; remounting resets it.
  const [sendResetKey, setSendResetKey] = useState(0);
  const [customSchedule, setCustomSchedule] = useState<CustomSchedule | null>(null);
  const [quote, setQuote] = useState<ComposeQuote | null>(null);
  const [originalQuote, setOriginalQuote] = useState<ComposeQuote | null>(null);
  const [quoteRemoved, setQuoteRemoved] = useState(false);
  const [quoteEditing, setQuoteEditing] = useState(false);
  // Bumped by "restore original" so the edit frame drops unsaved edits even when the quote itself is unchanged.
  const [quoteRevision, setQuoteRevision] = useState(0);
  const [preview, setPreview] = useState<ComposePreviewData | null>(null);
  const quoteFrameRef = useRef<HTMLIFrameElement | null>(null);
  const quoteBaseline = useRef<string | null>(null);
  const autosavedQuoteEdit = useRef<string | null>(null);
  const quoteEditingRef = useRef(false);
  // Set once a snapshot is restored: late arrivals from the init effect must not overwrite it.
  const restoredRef = useRef(false);

  const setEditingQuote = (editing: boolean) => {
    quoteEditingRef.current = editing;
    setQuoteEditing(editing);
  };

  const applyQuote = useCallback((next: ComposeQuote | null) => {
    setQuote(next);
    setOriginalQuote(next);
    setQuoteRemoved(false);
    quoteEditingRef.current = false;
    setQuoteEditing(false);
  }, []);

  // Late arrivals (fetched body, resolved inline images) must not undo a restore, an edit or a removal.
  const upgradeQuote = useCallback((base: ComposeQuote | null, next: ComposeQuote) => {
    if (restoredRef.current) return;
    setQuote((cur) => (cur === base && !quoteEditingRef.current ? next : cur));
    setOriginalQuote((cur) => (cur === base ? next : cur));
  }, []);

  // The edit frame's current content, or null while it still matches what it loaded with.
  const readQuoteEdit = (): string | null => {
    const root = quoteFrameRef.current?.contentDocument?.getElementById(QUOTE_EDIT_ROOT);
    if (!root || root.innerHTML === quoteBaseline.current) return null;
    return restoreSanitizedHtml(root.innerHTML);
  };

  const outgoingQuoteHtml = (edited = quoteEditing ? readQuoteEdit() : null): string => {
    if (!quote || quoteRemoved) return "";
    return renderQuote(edited === null ? quote : { ...quote, body: edited });
  };

  const finishQuoteEdit = () => {
    const edited = readQuoteEdit();
    if (edited !== null && quote) setQuote({ ...quote, body: edited });
    setEditingQuote(false);
  };

  const handleQuoteEditBaseline = (html: string) => {
    quoteBaseline.current = html;
    autosavedQuoteEdit.current = null;
  };

  const handleQuoteFrameLoad = () => {
    quoteFrameRef.current?.contentDocument?.getElementById(QUOTE_EDIT_ROOT)?.focus({ preventScroll: true });
  };

  const emailsOf = (list: string[]) => list.map((r) => {
    const m = r.match(/<([^>]+)>/);
    return (m ? m[1] : r).trim().toLowerCase();
  });

  const fileInputRef = useRef<HTMLInputElement>(null);
  const templateBtnRef = useRef<HTMLDivElement>(null);
  const scheduleBtnRef = useRef<HTMLDivElement>(null);
  const dragCounter = useRef(0);

  // Headless: EditorToolbar/EditorContent are rendered at their own spots below
  // since AI-reply suggestions sit between them in this layout.
  const pasteRef = useRef<(files: SortedPaste) => void>(() => {});
  const editor = useRichTextEditor({
    content: "",
    placeholder: i18n.t("compose.writeMessage"),
    extraExtensions: [
      TiptapImage.configure({ inline: true, allowBase64: true }),
      SignatureNode,
      FilePaste.configure({ onPaste: (f) => pasteRef.current(f) }),
    ],
  });
  pasteRef.current = ({ inline, attachments: pasted }) => {
    if (pasted.length > 0) addFiles(pasted);
    for (const file of inline) {
      void prepareImage(file).then((p) => {
        // Width 0: the webview could not decode it, so it would show as a broken image in the text.
        if (!p || !p.width || !editor) {
          addFiles([file]);
          return;
        }
        editor
          .chain()
          .focus()
          .setImage({ src: `data:${p.type};base64,${p.data}`, width: displayWidth(p.width, window.devicePixelRatio) })
          .run();
      });
    }
  };

  // ── Autosave: crash/quit safety net ──────────────────────────────────────
  // Snapshots the whole draft into SQLite keyed by this window's label; a
  // clean close deletes it (ComposeWindow), leftovers are offered for restore
  // at next launch (App.tsx). Editor keystrokes don't re-render this
  // component, so dirtiness is tracked via the TipTap update event.
  const autosaveDirty = useRef(false);
  useEffect(() => {
    if (!editor) return;
    const markDirty = () => { autosaveDirty.current = true; };
    editor.on("update", markDirty);
    return () => { editor.off("update", markDirty); };
  }, [editor]);
  useEffect(() => {
    autosaveDirty.current = true;
  }, [to, cc, bcc, subject, attachments, fromAccountId, quote, quoteRemoved]);

  useEffect(() => {
    if (!initData) return; // only real compose windows persist autosaves
    const label = getCurrentWindow().label;
    const interval = setInterval(() => {
      const quoteEdit = quoteEditing ? readQuoteEdit() : null;
      if (quoteEdit !== null && quoteEdit !== autosavedQuoteEdit.current) {
        autosavedQuoteEdit.current = quoteEdit;
        autosaveDirty.current = true;
      }
      if (!autosaveDirty.current || sending || savingDraft || !editor) return;
      const hasContent =
        editor.getText().trim().length > 0 || subject.trim().length > 0 ||
        to.length > 0 || cc.length > 0 || bcc.length > 0 || attachments.length > 0;
      if (!hasContent) return;
      autosaveDirty.current = false;
      const quotedHtml = outgoingQuoteHtml(quoteEdit);
      const { bodyHtml, bodyText } = buildOutgoingBody(quotedHtml);
      const snapshot: ComposeSnapshot = {
        to: [...to],
        cc: [...cc],
        bcc: [...bcc],
        subject,
        bodyHtml,
        bodyText,
        fromAccountId: fromAccountId ?? "",
        attachments: attachments
          .filter((att) => att.status === "ready")
          .map((att) => ({ name: att.name, size: att.size, type: att.type, data: att.data })),
        quotedHtml: quotedHtml || undefined,
      };
      const payload = JSON.stringify({ mode, originalMail: originalMail ?? null, snapshot });
      saveComposeAutosave(label, payload)
        .then(() => setLastSavedAt(new Date()))
        .catch((err) => {
          autosaveDirty.current = true;
          console.error("[autosave]", err);
        });
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initData, editor, sending, savingDraft, to, cc, bcc, subject, attachments, fromAccountId, quote, quoteRemoved, quoteEditing, mode, originalMail]);

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
      return `<div data-type="signature"><p>${escapeHtml(account.signature_text).replace(/\n/g, "<br>")}</p></div>`;
    }
    return "";
  }, [accounts]);

  useEffect(() => {
    let cancelled = false;
    if (!isOpen || !editor) return;

    setSendError(null);
    restoredRef.current = false;
    applyQuote(null);
    let initialQuote: ComposeQuote | null = null;
    const startQuote = (q: ComposeQuote | null) => {
      initialQuote = q;
      applyQuote(q);
    };
    const resolveDraftQuoteImages = (mail: Mail, base: ComposeQuote) => {
      void withResolvedInlineImages(mail).then((m) => {
        const resolved = m?.body_html ? splitQuote(m.body_html).quote : null;
        if (resolved && !cancelled) upgradeQuote(base, resolved);
      });
    };

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

    // Carry the attachments of a draft/reply/forward into the composer. An attachment
    // that cannot be loaded is kept in the list as "failed" instead of being dropped:
    // the user sees which file is missing and cannot send until it is resolved.
    async function loadAttachmentsFrom(mailId: string) {
      let atts: Awaited<ReturnType<typeof listAttachments>>;
      try {
        await fetchMailBody(mailId);
        if (cancelled) return;
        atts = await listAttachments(mailId);
      } catch (err) {
        if (cancelled) return;
        addToast("error", t("compose.attachmentsLoadFailed"), err instanceof Error ? err.message : String(err));
        return;
      }
      if (cancelled) return;

      const files: AttachmentFile[] = [];
      for (const att of atts.filter((a) => !a.is_inline)) {
        if (cancelled) return;
        try {
          const payload = await getAttachmentData(att.id);
          files.push({
            id: att.id,
            name: payload.name,
            size: payload.size,
            type: payload.mime_type,
            data: payload.data,
            status: "ready",
          });
        } catch (err) {
          files.push({
            id: att.id,
            name: att.filename,
            size: att.size_bytes ?? 0,
            type: att.mime_type ?? "application/octet-stream",
            data: "",
            status: "failed",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      if (cancelled || restoredRef.current) return;
      setAttachments(files);
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
      // Use draft body as-is (no signature injection); a quote we wrote goes back into its card.
      const draftBody = originalMail.body_html || originalMail.body_text;
      if (draftBody) {
        const { rest, quote: draftQuote } = splitQuote(draftBody);
        content = rest;
        startQuote(draftQuote);
        if (draftQuote) resolveDraftQuoteImages(originalMail, draftQuote);
      } else {
        // Body not loaded yet (header-only sync) — fetch it
        content = "<p></p>";
        fetchMailBody(originalMail.id)
          .then((updated) => {
            if (cancelled || restoredRef.current) return;
            const body = updated.body_html || updated.body_text || "";
            if (body && editor) {
              const { rest, quote: draftQuote } = splitQuote(body);
              setComposeBody(editor, rest);
              if (draftQuote) {
                upgradeQuote(null, draftQuote);
                resolveDraftQuoteImages(updated, draftQuote);
              }
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
        const q = quoteFromMail("reply", originalMail);
        startQuote(q);
        void withResolvedInlineImages(originalMail).then((m) => { if (m && !cancelled) upgradeQuote(q, quoteFromMail("reply", m)); });
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
        const q = quoteFromMail("reply", originalMail);
        startQuote(q);
        void withResolvedInlineImages(originalMail).then((m) => { if (m && !cancelled) upgradeQuote(q, quoteFromMail("reply", m)); });
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
        const q = quoteFromMail("forward", originalMail);
        startQuote(q);
        void withResolvedInlineImages(originalMail).then((m) => { if (m && !cancelled) upgradeQuote(q, quoteFromMail("forward", m)); });
        content = `<p></p>${signature}`;

        if (originalMail.has_attachments) {
          void loadAttachmentsFrom(originalMail.id);
        }
      }
    }

    setComposeBody(editor, content);

    // Fallback: if reply/forward originalMail has no body, fetch it and update editor
    if (originalMail && (mode === "reply" || mode === "replyAll" || mode === "forward") && !originalMail.body_html && !originalMail.body_text) {
      fetchMailBody(originalMail.id)
        .then((updated) => {
          if (cancelled || restoredRef.current) return;
          if (!editor || !(updated.body_html || updated.body_text)) return;
          const isReply = mode === "reply" || mode === "replyAll";
          const sig = getSignatureHtml(defaultAccountId, true);
          const quoteOf = (m: Mail) => quoteFromMail(isReply ? "reply" : "forward", m);
          const fetched = quoteOf(updated);
          upgradeQuote(initialQuote, fetched);
          void withResolvedInlineImages(updated).then((m) => { if (m && !cancelled) upgradeQuote(fetched, quoteOf(m)); });
          if (isReply && composeAiReplyText) {
            const aiHtml = `<p>${composeAiReplyText.replace(/\n/g, '<br>')}</p>`;
            setComposeBody(editor, `${aiHtml}${sig}`);
          } else {
            setComposeBody(editor, `<p></p>${sig}`);
          }
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [isOpen, mode, originalMail, accounts, selectedAccountId, editor, getSignatureHtml, mailtoParams, composeAiReplyText, applyQuote, upgradeQuote]);

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
    // The snapshot is only taken once the send guard has confirmed every attachment
    // was loaded, so these are ready by construction.
    setAttachments(
      restoreSnapshot.attachments.map((att) => ({
        ...att,
        id: crypto.randomUUID(),
        status: "ready" as const,
      })),
    );
    restoredRef.current = true;
    applyQuote(quoteFromHtml(restoreSnapshot.quotedHtml));
    setComposeBody(editor, bodyWithoutQuote(restoreSnapshot.bodyHtml, restoreSnapshot.quotedHtml));
    // Clear snapshot so it doesn't re-apply
    useAppStore.getState().clearUndoSend();
  }, [isOpen, editor, restoreSnapshot, applyQuote]);

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

  // A template or AI draft replaces the whole body, so it never lands silently on what the user wrote.
  function confirmReplaceText() {
    return dialog.confirm({
      title: t("compose.replaceTextTitle"),
      message: t("compose.replaceTextMessage"),
      confirmLabel: t("compose.replaceText"),
    });
  }

  async function handleUseAiReply(text: string) {
    if (!editor) return;
    if (hasOwnText(editor) && !(await confirmReplaceText())) return;
    const aiHtml = `<p>${text.replace(/\n/g, '<br>')}</p>`;
    const signature = getSignatureHtml(fromAccountId, true);
    editor.commands.setContent(aiHtml + signature);
    setAiReplies([]);
    editor.commands.focus("start");
  }

  async function handleApplyTemplate(template: EmailTemplate) {
    if (!editor) return;
    setShowTemplateMenu(false);
    const replacesSubject = !!template.subject && !!subject.trim() && subject.trim() !== template.subject.trim();
    if ((hasOwnText(editor) || replacesSubject) && !(await confirmReplaceText())) return;
    if (template.subject) setSubject(template.subject);
    // Prefer body_text (the panel's source of truth), escaped here — templates
    // saved before the escaping fix carry broken unescaped body_html.
    const bodyContent = template.body_text
      ? `<p>${escapeHtml(template.body_text).replace(/\n/g, "<br>")}</p>`
      : template.body_html;
    const signature = getSignatureHtml(fromAccountId, false);
    editor.commands.setContent(bodyContent + signature);
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
      setComposeBody(editor, html.replace(sigRegex, newSig));
    } else if (newSig) {
      setComposeBody(editor, html + newSig);
    }
  }

  function readFileAsBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(reader.error ?? new Error("read failed"));
      reader.onload = () => {
        const base64 = (reader.result as string).split(",")[1];
        if (!base64) {
          reject(new Error("empty file"));
          return;
        }
        resolve(base64);
      };
      reader.readAsDataURL(file);
    });
  }

  function addFiles(files: FileList | File[]) {
    Array.from(files).forEach((file) => {
      if (tooLargeToRead(file)) {
        setSendError(t("compose.fileTooLarge", { name: file.name }));
        addToast("error", t("compose.fileTooLarge", { name: file.name }));
        return;
      }

      const id = crypto.randomUUID();
      let isDuplicate = false;

      // Insert as "loading" first, so a send attempt while the file is still being
      // read is blocked rather than silently dropping it. The dedup check happens in
      // the updater, where `prev` is the current list — reading `attachments` from the
      // closure misses files added earlier in this same batch.
      setAttachments((prev) => {
        if (prev.some((a) => (a.source?.name ?? a.name) === file.name && (a.source?.size ?? a.size) === file.size)) {
          isDuplicate = true;
          return prev;
        }
        return [
          ...prev,
          {
            id,
            name: file.name,
            size: file.size,
            type: file.type || "application/octet-stream",
            data: "",
            status: "loading",
            source: { name: file.name, size: file.size },
          },
        ];
      });

      if (isDuplicate) {
        addToast("warning", t("compose.fileAlreadyAttached", { name: file.name }));
        return;
      }

      const isImage = file.type.startsWith("image/");
      (isImage ? prepareImage(file) : Promise.resolve(null))
        .then(async (prepared) => {
          const finalSize = prepared ? prepared.size : file.size;
          if (finalSize > MAX_ATTACHMENT_BYTES) {
            setAttachments((prev) => prev.filter((a) => a.id !== id));
            setSendError(t("compose.fileTooLarge", { name: file.name }));
            addToast("error", t("compose.fileTooLarge", { name: file.name }));
            return;
          }
          const base64 = prepared ? null : await readFileAsBase64(file);
          setAttachments((prev) =>
            prev.map((a) => {
              if (a.id !== id) return a;
              if (prepared) return { ...withPrepared(a, prepared), status: "ready" as const };
              return { ...a, data: base64 ?? "", status: "ready" as const };
            }),
          );
        })
        .catch((err) => {
          const reason = err instanceof Error ? err.message : String(err);
          setAttachments((prev) =>
            prev.map((a) => (a.id === id ? { ...a, status: "failed" as const, error: reason } : a)),
          );
          addToast("error", t("compose.attachmentReadFailed", { name: file.name }));
        });
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
  function buildOutgoingBody(quotedHtml = outgoingQuoteHtml()): { bodyHtml: string; bodyText: string } {
    if (!editor) return { bodyHtml: quotedHtml, bodyText: "" };
    // Only on the way out: the editor writes a blank line as `<p></p>`, which
    // collapses to nothing when a mail client renders it — and its paragraph
    // spacing/font live in our stylesheet, which does not travel with the mail.
    const editorHtml = addSignatureDivider(inlineComposeStyles(fillEmptyParagraphs(editor.getHTML()), typography), currentAccentHex());
    const editorText = editor.getText({ blockSeparator: '\n\n' });
    const bodyHtml = editorHtml + quotedHtml;
    const bodyText = editorText + (quotedHtml ? "\n\n" + quotedHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "");
    return { bodyHtml, bodyText };
  }

  function confirmMissingAttachment() {
    return dialog.confirm({
      title: t("compose.attachmentReminderTitle"),
      message: t("compose.attachmentReminderMessage"),
      confirmLabel: t("compose.sendWithoutAttachment"),
    });
  }

  // Sending now and scheduling ask the same questions; only the moment differs.
  async function passesSendChecks(effTo: string[], effCc: string[], effBcc: string[]): Promise<boolean> {
    const blocker = sendBlocker(effTo, effCc, effBcc, !!fromAccountId);
    if (blocker) {
      setSendError(blocker.key === "compose.invalidEmail" ? t(blocker.key, { email: blocker.email }) : t(blocker.key));
      return false;
    }
    if (!editor) return false;
    setSendError(null);

    if (!subject.trim()) {
      const confirmed = await dialog.confirm({
        title: t("compose.noSubjectTitle"),
        message: t("compose.noSubjectMessage"),
        confirmLabel: t("compose.sendWithoutSubject"),
      });
      if (!confirmed) return false;
    }

    if (needsAttachmentReminder(editor, attachments.length) && !(await confirmMissingAttachment())) return false;

    const recipientCount = countRecipients(effTo, effCc, effBcc);
    if (recipientCount > MANY_RECIPIENTS) {
      const ok = await dialog.confirm({
        title: t("compose.manyRecipientsTitle"),
        message: t("compose.manyRecipientsMessage", { count: recipientCount }),
      });
      if (!ok) return false;
    }

    // Anything not fully in memory stops the mail: sending is irreversible, and a
    // scheduled mail goes out unattended, after the user could still fix it.
    const notReady = attachments.filter((att) => att.status !== "ready");
    if (notReady.length > 0) {
      const stillLoading = notReady.every((att) => att.status === "loading");
      await dialog.alert({
        type: stillLoading ? "info" : "danger",
        title: stillLoading ? t("compose.attachmentsStillLoadingTitle") : t("compose.attachmentsFailedTitle"),
        message: stillLoading
          ? t("compose.attachmentsStillLoadingMessage")
          : t("compose.attachmentsFailedMessage", {
              names: notReady.filter((a) => a.status === "failed").map((a) => a.name).join(", "),
            }),
      });
      return false;
    }
    return true;
  }

  async function handleSend(): Promise<boolean> {
    const pendingTo = toFieldRef.current?.commitPending() ?? null;
    const pendingCc = ccFieldRef.current?.commitPending() ?? null;
    const pendingBcc = bccFieldRef.current?.commitPending() ?? null;
    const effTo = pendingTo ? [...to, pendingTo] : to;
    const effCc = pendingCc ? [...cc, pendingCc] : cc;
    const effBcc = pendingBcc ? [...bcc, pendingBcc] : bcc;

    if (!(await passesSendChecks(effTo, effCc, effBcc)) || !editor || !fromAccountId) return false;

    const quotedHtml = outgoingQuoteHtml();
    const { bodyHtml: localHtml, bodyText } = buildOutgoingBody(quotedHtml);
    // Quoted signature images are stored as file:// paths for display — they
    // must leave as cid: inline attachments, never as local paths.
    const { html: bodyHtml, inlineAttachments } = await embedInlineImages(stripQuoteMarker(localHtml), originalMail ?? null);

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
      attachments: [
        ...attachments.map((att) => ({
          name: att.name,
          mime_type: att.type,
          data: att.data,
          size: att.size,
        })),
        ...inlineAttachments,
      ],
    };

    const snapshot: ComposeSnapshot = {
      to: [...effTo],
      cc: [...effCc],
      bcc: [...effBcc],
      subject,
      // The snapshot restores a local compose window — keep the file:// form.
      bodyHtml: localHtml,
      bodyText,
      fromAccountId,
      attachments: attachments.map((att) => ({
        name: att.name,
        size: att.size,
        type: att.type,
        data: att.data,
      })),
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
        // IMAP accounts mirror the sent copy in the background and emit
        // mails-changed once it lands — no full sync needed. API accounts
        // (Gmail/Outlook OAuth) get their sent copy only via their quiet
        // incremental sync, so trigger that one.
        const sentAccount = accounts?.find((a) => a.id === request.account_id);
        if (sentAccount && (sentAccount.provider === "google" || sentAccount.provider === "microsoft") && sentAccount.auth_type === "oauth") {
          syncAccount(request.account_id).catch(() => {});
        }
        // The window is about to be destroyed — confirmation lives in the main window.
        emit("mail-sent");
        onClose();
      }).catch((err) => {
        setSendError(err instanceof Error ? err.message : String(err));
        setSendResetKey((k) => k + 1);
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
      // Cmd+W on macOS is the native File > Close item; the webview only
      // covers the platforms without a menu bar.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === "w" && !isMacOS) {
        e.preventDefault();
        if (escBlockedRef.current) return;
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

    // Guard against a past schedule time (e.g. typed past the picker's min).
    if (isNaN(scheduledDate.getTime()) || scheduledDate.getTime() <= Date.now()) {
      setSendError(t("compose.scheduledInPast"));
      return;
    }

    if (!(await passesSendChecks(effTo, effCc, effBcc)) || !editor || !fromAccountId) return;

    const { bodyHtml: localHtml, bodyText } = buildOutgoingBody();
    // Same as handleSend: quoted signature images leave as cid: inline parts.
    const { html: bodyHtml, inlineAttachments } = await embedInlineImages(stripQuoteMarker(localHtml), originalMail ?? null);

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
      attachments: [
        ...attachments.map((att) => ({
          name: att.name,
          mime_type: att.type,
          data: att.data,
          size: att.size,
        })),
        ...inlineAttachments,
      ],
    };

    setSending(true);
    setShowScheduleMenu(false);
    const isoDate = scheduledDate.toISOString().replace("T", " ").replace("Z", "");
    scheduleSend(request, isoDate)
      .then(() => {
        // The window is about to be destroyed — confirmation lives in the main window.
        emit("mail-scheduled", { scheduled_at: scheduledDate.toISOString() });
        onClose();
      })
      .catch((err) => setSendError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSending(false));
  }

  function handleScheduleCustom() {
    const start = new Date();
    start.setHours(start.getHours() + 2, 0, 0, 0);
    setCustomSchedule({ date: isoDate(start), time: format(start, "HH:mm") });
  }

  const dialog = useDialog();
  // Keep escBlockedRef current every render so the capture-once keydown listener
  // can check it without a stale closure.
  escBlockedRef.current = showDiscardDialog || linkDialogOpen || dialog.isOpen || preview !== null;

  function openPreview() {
    const account = accounts?.find((a) => a.id === fromAccountId);
    setPreview({
      from: account ? (account.display_name ? `${account.display_name} <${account.email}>` : account.email) : "",
      to,
      cc,
      bcc,
      subject,
      attachments: attachments.map((a) => a.name),
      html: buildOutgoingBody().bodyHtml,
    });
  }

  function handleDiscardClick() {
    const hasContent = editor ? editor.getText().trim().length > 0 : false;
    if (hasContent || subject.trim() || to.length > 0 || cc.length > 0 || bcc.length > 0 || attachments.length > 0) {
      setShowDiscardDialog(true);
    } else {
      onClose();
    }
  }
  handleDiscardRef.current = handleDiscardClick;

  // Expose requestClose so ComposeWindow can trigger the discard check
  useImperativeHandle(ref, () => ({ requestClose: handleDiscardClick }), [editor, subject, to, cc, bcc, attachments]);

  async function handleSaveDraft() {
    if (!fromAccountId || !editor) return;

    setSavingDraft(true);
    setShowDiscardDialog(false);

    try {
      const editorHtml = editor.getHTML();
      const editorText = editor.getText({ blockSeparator: '\n\n' });
      const quotedHtml = outgoingQuoteHtml();
      const localHtml = editorHtml + quotedHtml;
      const bodyText = editorText + (quotedHtml ? "\n\n" + quotedHtml.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim() : "");
      // The draft is APPENDed to the server's Drafts folder — quoted signature
      // images must go as cid: inline parts there too, never as local paths.
      const { html: bodyHtml, inlineAttachments } = await embedInlineImages(localHtml, originalMail ?? null);

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
        // Only attachments whose bytes are present go into the draft — a failed one
        // would be baked in as an empty file and the send guard could never clear it.
        // The user is told which ones were left out.
        attachments: [
          ...attachments
            .filter((att) => att.status === "ready")
            .map((att) => ({
              name: att.name,
              mime_type: att.type,
              data: att.data,
              size: att.size,
            })),
          ...inlineAttachments,
        ],
      };

      const omitted = attachments.filter((att) => att.status !== "ready");
      if (omitted.length > 0) {
        addToast(
          "warning",
          t("compose.draftAttachmentsOmittedTitle"),
          t("compose.draftAttachmentsOmittedMessage", { names: omitted.map((a) => a.name).join(", ") }),
        );
      }

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
  const canSend = (to.length > 0 || toHasPending) && !sending;

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
                  <Select
                    value={fromAccountId}
                    onChange={handleFromChange}
                    options={accounts.map((account) => ({
                      value: account.id,
                      label: `${account.display_name} <${account.email}>`,
                    }))}
                    className="w-full flex items-center gap-2 bg-transparent text-sm font-medium text-text pr-1 text-left focus:outline-none"
                  />
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
              onPendingChange={setToHasPending}
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
              className="compose-writing flex-1 bg-transparent text-sm text-text placeholder:text-text-secondary"
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

          <div className="p-4 min-h-[250px]">
            <EditorContent
              editor={editor}
              className="compose-editor text-sm text-text leading-relaxed"
              style={{ "--compose-font": typography.fontStack, "--compose-font-size": `${typography.fontSizePt}pt` } as React.CSSProperties}
            />
            {quote && !quoteRemoved && (
              <div className="mt-5">
                <QuoteCard
                  key={quoteRevision}
                  quote={quote}
                  editing={quoteEditing}
                  onEdit={() => setEditingQuote(true)}
                  onDone={finishQuoteEdit}
                  onRestore={() => {
                    setQuote(originalQuote);
                    setQuoteRevision((r) => r + 1);
                    autosaveDirty.current = true;
                  }}
                  onRemove={() => setQuoteRemoved(true)}
                  onFrameRef={(el) => { quoteFrameRef.current = el; }}
                  onFrameLoad={handleQuoteFrameLoad}
                  onEditBaseline={handleQuoteEditBaseline}
                />
              </div>
            )}
            {quote && quoteRemoved && (
              <button
                type="button"
                onClick={() => setQuoteRemoved(false)}
                className="mt-4 -ml-2 inline-flex items-center gap-1.5 px-2 py-1 rounded text-xs text-text-secondary hover:text-text hover:bg-hover transition-colors"
              >
                <Undo2 className="w-3.5 h-3.5" />
                <span>{t(quote.kind === "forward" ? "compose.quoteReinsertForward" : "compose.quoteReinsertReply")}</span>
              </button>
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
                  const failed = att.status === "failed";
                  const loading = att.status === "loading";
                  return (
                    <div
                      key={att.id}
                      title={failed ? att.error : undefined}
                      className={`group relative flex flex-col items-center p-3 rounded-lg bg-bg-secondary border transition-colors ${
                        failed ? "border-danger" : "border-border hover:border-border-light"
                      }`}
                    >
                      <button
                        onClick={() => removeAttachment(index)}
                        className="absolute top-1 right-1 p-1 rounded-full bg-surface border border-border opacity-0 group-hover:opacity-100 hover:bg-danger hover:border-danger hover:text-white text-text-tertiary transition-all"
                      >
                        <X className="w-3 h-3" />
                      </button>
                      <div className={`w-10 h-10 rounded-lg bg-surface flex items-center justify-center mb-2 ${failed ? "text-danger" : iconColor}`}>
                        {loading ? (
                          <Loader2 className="w-5 h-5 animate-spin text-text-tertiary" />
                        ) : (
                          <FileIcon className="w-6 h-6" />
                        )}
                      </div>
                      <span className="text-xs text-text truncate w-full text-center font-medium">{att.name}</span>
                      <span className={`text-[11px] ${failed ? "text-danger" : "text-text-tertiary"}`}>
                        {failed
                          ? t("compose.attachmentFailed")
                          : loading
                            ? t("compose.attachmentLoading")
                            : formatFileSize(att.size)}
                      </span>
                      {!failed && !loading && att.shrunkFrom != null && (
                        <span className="text-[11px] text-text-tertiary">
                          {t("compose.imageShrunk", {
                            from: formatFileSize(att.shrunkFrom),
                            to: formatFileSize(att.size),
                          })}
                        </span>
                      )}
                      {!failed && !loading && att.locationRemoved && (
                        <span className="text-[11px] text-text-tertiary">{t("compose.locationRemoved")}</span>
                      )}
                      {!failed && !loading && att.original && (
                        <button
                          onClick={() =>
                            setAttachments((prev) => prev.map((a) => (a.id === att.id ? toOriginal(a) : a)))
                          }
                          className="text-[11px] text-accent hover:underline"
                        >
                          {t("compose.sendOriginal")}
                        </button>
                      )}
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
                    <div className="absolute bottom-full left-0 mb-2 min-w-[200px] max-w-[280px] bg-surface rounded-lg shadow-lg inset-shadow-edge border border-border py-1 z-50 overflow-hidden">
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
                  <span>{t("compose.savedAgo", { time: formatDistanceToNowStrict(lastSavedAt, { addSuffix: true, locale: dateLocale() }) })}</span>
                </>
              ) : null}
            </div>
            <div className="flex items-center gap-2">
              <IconButton
                icon={<Eye />}
                aria-label={t("compose.preview")}
                title={t("compose.preview")}
                onClick={openPreview}
              />
              <div ref={scheduleBtnRef} className="relative">
                <div
                  aria-disabled={!canSend}
                  className={`send-split relative flex items-stretch rounded-control border tactile-filled active:duration-0 transition-[box-shadow,transform,filter,border-color,opacity] duration-150 ease-out ${
                    sendPhase !== "idle" ? "[--tactile-fill:var(--c-success)]" : ""
                  } ${to.length === 0 && !toHasPending ? "opacity-50" : ""}`}
                >
                  {/* Green is the "go" colour: from sending to sent it fills the whole split as one confirmation. */}
                  <motion.span
                    aria-hidden
                    className="absolute inset-0 rounded-[inherit] pointer-events-none"
                    style={{ background: "linear-gradient(180deg, color-mix(in srgb, var(--c-success) 88%, white) 0%, var(--c-success) 50%, color-mix(in srgb, var(--c-success) 88%, black) 100%)" }}
                    initial={false}
                    animate={{ opacity: sendPhase !== "idle" ? 1 : 0 }}
                    transition={SPRING_SNAPPY}
                  />
                  <SendButton key={sendResetKey} onSend={handleSend} disabled={to.length === 0 && !toHasPending} onPhaseChange={setSendPhase} />
                  <button
                    onClick={() => {
                      setShowScheduleMenu(!showScheduleMenu);
                      setCustomSchedule(null);
                    }}
                    disabled={!canSend}
                    className="relative flex items-center px-2 text-on-accent rounded-r-control border-l disabled:cursor-default"
                    style={{ borderLeftColor: "color-mix(in srgb, var(--c-on-accent) 25%, transparent)" }}
                  >
                    <ChevronDown className="w-4 h-4" />
                  </button>
                </div>
                {showScheduleMenu && (
                  <div className="absolute bottom-full right-0 mb-2 min-w-[200px] bg-surface rounded-lg shadow-lg inset-shadow-edge border border-border py-1 z-50 overflow-hidden">
                    <div className="px-3 py-1.5 text-xs font-semibold text-text-tertiary flex items-center gap-1.5">
                      <CalendarClock className="w-3.5 h-3.5" />
                      {t("scheduled.scheduleSend")}
                    </div>
                    {customSchedule ? (
                      <CustomScheduleForm
                        value={customSchedule}
                        onChange={setCustomSchedule}
                        onBack={() => setCustomSchedule(null)}
                        onSchedule={handleScheduleSend}
                      />
                    ) : (
                      <>
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
                      </>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {preview && <ComposePreview data={preview} onClose={() => setPreview(null)} />}

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
            <div className="px-4 py-3 border-b border-border bg-bg-secondary inset-shadow-edge">
              <h3 className="text-sm font-semibold text-text">{t("compose.saveDraftTitle")}</h3>
            </div>
            <div className="p-4">
              <p className="text-sm text-text-secondary mb-4">
                {t("compose.saveDraftMessage")}
              </p>
              <div className="flex flex-col gap-2">
                <Button
                  size="md"
                  onClick={handleSaveDraft}
                  loading={savingDraft}
                  fullWidth
                >
                  {savingDraft ? t("compose.saving") : t("compose.saveDraft")}
                </Button>
                <Button
                  variant="ghost"
                  size="md"
                  onClick={handleDiscardConfirm}
                  disabled={savingDraft}
                  fullWidth
                  className="text-danger! hover:bg-danger/10!"
                >
                  {t("compose.discardMessage")}
                </Button>
                <Button
                  variant="ghost"
                  size="md"
                  onClick={() => setShowDiscardDialog(false)}
                  disabled={savingDraft}
                  fullWidth
                >
                  {t("compose.keepEditing")}
                </Button>
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
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-bg-secondary inset-shadow-edge">
              <h2 className="text-sm font-semibold text-text">{modeTitle}</h2>
              <button
                onClick={handleRequestClose}
                className="p-1.5 rounded-control hover:bg-hover transition-colors text-text-tertiary"
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
