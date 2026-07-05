import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { parseISO } from "date-fns";
import { Reply, ReplyAll, Forward, Archive, Paperclip, FileText, Image, Film, Music, File, Loader2, Code, FileType, Download, Copy, Check, Printer } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { convertFileSrc } from "@tauri-apps/api/core";
import gsap from "gsap";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../../stores/appStore";
import { useAttachments, useToggleStar, useToggleMailFlag } from "../../hooks/useAccounts";
import { openAttachment, saveAttachment, fetchMailBody, toggleRead, trashMail, archiveMail, markAsRead, getMail } from "../../lib/tauri";
import { MAIL_LINK_BRIDGE, MAIL_LINK_BRIDGE_CSP_HASH } from "../../lib/mailLinkBridge";
import { openMailUrl } from "../../lib/trackingParams";
import { FlagPicker } from "../ui/FlagPicker";
import { ContactAvatar } from "../ui/ContactAvatar";
import type { MailFlag } from "../../types";
import { EmptyState } from "../ui/EmptyState";
import { DaylightSky, useAtmosphereLine } from "../motion/DaylightSky";
import { StarIcon, TrashIcon, MailFilledIcon, SendIcon } from "../icons";
import { IconButton } from "../ui/Button";
import { ThreadView } from "./ThreadView";
import { formatDateTime } from "../../lib/dateUtils";
import { sanitizeEmailHtml, type TrackerInfo } from "../../lib/sanitize";
import { TrackingIndicator } from "./TrackingIndicator";
import { AiSummaryButton, AiSummaryPanel } from "../ai/AiSummary";
import { AiReplyButton, AiReplySuggestionsPanel } from "../ai/AiReplySuggestions";
import { useTranslation } from "react-i18next";
import { useDialog } from "../ui/DialogProvider";
import type { Mail, Attachment } from "../../types";
import { MailDetailSkeleton } from "../ui/MailDetailSkeleton";
import { ImageLightbox, type ImageLightboxItem } from "./ImageLightbox";

function MailToolbar({ mail, onPrint, showAiSummary, onToggleAiSummary, showAiReplies, onToggleAiReplies }: { mail: Mail; onPrint?: () => void; showAiSummary?: boolean; onToggleAiSummary?: () => void; showAiReplies?: boolean; onToggleAiReplies?: () => void }) {
  const { t } = useTranslation();
  const mails = useAppStore((s) => s.mails);
  const setMails = useAppStore((s) => s.setMails);
  const setSelectedMailId = useAppStore((s) => s.setSelectedMailId);
  const selectedMailIndex = useAppStore((s) => s.selectedMailIndex);
  const openCompose = useAppStore((s) => s.openCompose);
  const setPendingRemoveId = useAppStore((s) => s.setPendingRemoveId);
  const folders = useAppStore((s) => s.folders);
  const selectedFolderId = useAppStore((s) => s.selectedFolderId);
  const queryClient = useQueryClient();
  const invalidateMailQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["folders"] });
    queryClient.invalidateQueries({ queryKey: ["all-inbox-mails"] });
    queryClient.invalidateQueries({ queryKey: ["combined-folder-mails"] });
    queryClient.invalidateQueries({ queryKey: ["split-inbox-mails"] });
  }, [queryClient]);
  const toggleStarMutation = useToggleStar();
  const toggleFlagMutation = useToggleMailFlag();
  const dialog = useDialog();
  const currentFolder = folders.find((f) => f.id === selectedFolderId);
  const isInTrash = currentFolder?.folder_type === "trash";

  function updateMail(updates: Partial<Mail>) {
    setMails((prev) => prev.map((m) => (m.id === mail.id ? { ...m, ...updates } : m)));
  }

  function selectNextMail() {
    const remaining = mails.filter((m) => m.id !== mail.id);
    if (remaining.length === 0) {
      setSelectedMailId(null);
    } else {
      const nextIndex = Math.min(selectedMailIndex, remaining.length - 1);
      setSelectedMailId(remaining[nextIndex].id);
    }
    setMails(remaining);
  }

  function handleStar() {
    const prev = mail.is_starred;
    updateMail({ is_starred: !prev });
    toggleStarMutation.mutate(mail.id, {
      onError: () => updateMail({ is_starred: prev }),
    });
  }

  function handleToggleRead() {
    const prev = mail.is_read;
    updateMail({ is_read: !prev });
    toggleRead(mail.id).then(() => invalidateMailQueries()).catch(() => updateMail({ is_read: prev }));
  }

  async function handleTrash() {
    // Only confirm when permanently deleting from trash
    if (isInTrash) {
      const confirmed = await dialog.danger({
        title: t("mailDetail.trash"),
        message: t("mailDetail.permanentDeleteConfirm", { name: mail.subject || t("compose.noSubject") }),
      });
      if (!confirmed) return;
    }
    selectNextMail();
    trashMail(mail.id)
      .then(() => invalidateMailQueries())
      .catch((e) => {
        dialog.alert({ type: "danger", title: t("common.error"), message: String(e) });
      });
  }

  async function handleArchive() {
    setPendingRemoveId(mail.id);
    archiveMail(mail.id)
      .then(() => invalidateMailQueries())
      .catch((e) => {
        dialog.alert({ type: "danger", title: t("common.error"), message: String(e) });
      });
  }

  function handleToggleFlag(flag: MailFlag) {
    const prevFlags = mail.flags || [];
    const newFlags = prevFlags.includes(flag)
      ? prevFlags.filter((f) => f !== flag)
      : [...prevFlags, flag];
    updateMail({ flags: newFlags });
    toggleFlagMutation.mutate({ mailId: mail.id, flag }, {
      onError: () => updateMail({ flags: prevFlags }),
    });
  }

  return (
    <div className="flex items-center justify-center gap-1">
      <button
        title={t("mailDetail.reply")}
        aria-label={t("mailDetail.reply")}
        onClick={() => openCompose("reply", mail)}
        className="p-2 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
      >
        <Reply className="w-4 h-4" />
      </button>
      <button
        title={t("mailDetail.replyAll")}
        aria-label={t("mailDetail.replyAll")}
        onClick={() => openCompose("replyAll", mail)}
        className="p-2 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
      >
        <ReplyAll className="w-4 h-4" />
      </button>
      <button
        title={t("mailDetail.forward")}
        aria-label={t("mailDetail.forward")}
        onClick={() => openCompose("forward", mail)}
        className="p-2 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
      >
        <SendIcon size={16} strokeWidth={1.5} />
      </button>
      {onPrint && (
        <button
          title={t("mailDetail.print")}
          aria-label={t("mailDetail.print")}
          onClick={onPrint}
          className="p-2 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
        >
          <Printer className="w-4 h-4" />
        </button>
      )}
      <button
        title={t("mailDetail.archive")}
        aria-label={t("mailDetail.archive")}
        onClick={handleArchive}
        className="p-2 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
      >
        <Archive className="w-4 h-4" />
      </button>
      <button
        title={t("mailDetail.trash")}
        aria-label={t("mailDetail.trash")}
        onClick={handleTrash}
        className="p-2 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
      >
        <TrashIcon size={16} strokeWidth={1.5} dangerHover />
      </button>
      <div className="w-px h-4 bg-border mx-1" />
      <FlagPicker flags={mail.flags || []} onToggleFlag={handleToggleFlag} />
      <button
        title={mail.is_starred ? t("mailDetail.unstar") : t("mailDetail.star")}
        aria-label={mail.is_starred ? t("mailDetail.unstar") : t("mailDetail.star")}
        onClick={handleStar}
        className={`p-2 rounded-lg hover:bg-hover transition-colors ${
          mail.is_starred ? "text-warning" : "text-text-tertiary"
        }`}
      >
        <StarIcon size={16} strokeWidth={1.5} color={mail.is_starred ? "var(--c-warning)" : "currentColor"} />
      </button>
      <button
        title={mail.is_read ? t("mailDetail.markUnread") : t("mailDetail.markRead")}
        aria-label={mail.is_read ? t("mailDetail.markUnread") : t("mailDetail.markRead")}
        onClick={handleToggleRead}
        className="p-2 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
      >
        <MailFilledIcon size={16} strokeWidth={1.5} />
      </button>
      {onToggleAiSummary && (
        <AiSummaryButton mailId={mail.id} onToggle={onToggleAiSummary} active={!!showAiSummary} />
      )}
      {onToggleAiReplies && (
        <AiReplyButton mailId={mail.id} onToggle={onToggleAiReplies} active={!!showAiReplies} />
      )}
    </div>
  );
}

function CopyEmailButton({ email }: { email: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function handleCopy(e: React.MouseEvent) {
    e.stopPropagation();
    await writeText(email);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <button
      onClick={handleCopy}
      title={t("mailDetail.copyEmail")}
      aria-label={t("mailDetail.copyEmail")}
      className="p-0.5 rounded hover:bg-hover transition-colors text-text-tertiary hover:text-text-secondary shrink-0"
    >
      {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
    </button>
  );
}

function MailHeader({ mail, onPrint, showAiSummary, onToggleAiSummary, showAiReplies, onToggleAiReplies }: { mail: Mail; onPrint?: () => void; showAiSummary?: boolean; onToggleAiSummary?: () => void; showAiReplies?: boolean; onToggleAiReplies?: () => void }) {
  const appSettings = useAppStore((s) => s.appSettings);
  const { t } = useTranslation();

  return (
    <div className="px-4 pt-4 pb-3 border-b border-border">
      <h2 className="text-lg font-semibold text-text mb-3">{mail.subject || t("compose.noSubject")}</h2>
      <div className="flex items-center gap-2.5">
        <ContactAvatar name={mail.from.name} email={mail.from.email} size={32} className="shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="font-medium text-text text-sm truncate">
              {mail.from.name || mail.from.email}
            </span>
            <span className="text-xs text-text-tertiary truncate">
              &lt;{mail.from.email}&gt;
            </span>
            <CopyEmailButton email={mail.from.email} />
          </div>
          <div className="text-xs text-text-tertiary truncate">
            to {mail.to.map((t) => t.name || t.email).join(", ")}
            {mail.cc.length > 0 && (
              <span>, cc: {mail.cc.map((c) => c.name || c.email).join(", ")}</span>
            )}
          </div>
        </div>
        <span className="text-xs text-text-tertiary shrink-0">
          {formatDateTime(parseISO(mail.date), appSettings.use_24h_clock)}
        </span>
      </div>
    </div>
  );
}

function getFileIcon(mimeType: string | null) {
  if (!mimeType) return File;
  if (mimeType.startsWith("image/")) return Image;
  if (mimeType.startsWith("video/")) return Film;
  if (mimeType.startsWith("audio/")) return Music;
  if (mimeType.includes("pdf") || mimeType.includes("document") || mimeType.includes("text")) return FileText;
  return File;
}

function formatFileSize(bytes: number | null): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function AttachmentItem({
  attachment,
  onImageClick,
}: {
  attachment: Attachment;
  onImageClick?: () => void;
}) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const Icon = getFileIcon(attachment.mime_type);
  const [saving, setSaving] = useState(false);
  const isImage = !!attachment.mime_type?.startsWith("image/");

  function handleOpen() {
    if (isImage && onImageClick) {
      onImageClick();
      return;
    }
    openAttachment(attachment.id).catch((err) => {
      addToast("error", t("errors.attachmentOpen"), err instanceof Error ? err.message : String(err));
    });
  }

  async function handleSave(e: React.MouseEvent) {
    e.stopPropagation();
    setSaving(true);
    try {
      await saveAttachment(attachment.id);
    } catch (err) {
      addToast("error", t("errors.attachmentSave"), err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-border hover:bg-hover transition-colors group">
      <button
        onClick={handleOpen}
        className="flex items-center gap-2 text-left min-w-0 flex-1"
      >
        {isImage && attachment.local_path ? (
          <div className="w-12 h-12 rounded overflow-hidden shrink-0 bg-hover">
            <img src={convertFileSrc(attachment.local_path)} alt="" className="w-full h-full object-cover" loading="lazy" />
          </div>
        ) : (
          <Icon className="w-4 h-4 text-text-tertiary shrink-0" />
        )}
        <span className="text-sm text-text truncate">{attachment.filename}</span>
        {attachment.size_bytes && (
          <span className="text-xs text-text-tertiary shrink-0">
            {formatFileSize(attachment.size_bytes)}
          </span>
        )}
      </button>
      <IconButton
        icon={saving ? <Loader2 className="animate-spin" /> : <Download />}
        aria-label={t("mailDetail.saveAttachment")}
        size="sm"
        onClick={handleSave}
        disabled={saving}
        className="opacity-0 group-hover:opacity-100"
      />
    </div>
  );
}

function AttachmentList({ mailId }: { mailId: string }) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const { data: attachments } = useAttachments(mailId);

  const visible = useMemo(() => (attachments ?? []).filter((a) => !a.is_inline), [attachments]);
  const imageItems = useMemo<ImageLightboxItem[]>(
    () =>
      visible
        .filter((a) => a.mime_type?.startsWith("image/") && a.local_path)
        .map((a) => ({
          id: a.id,
          filename: a.filename,
          src: convertFileSrc(a.local_path!),
          sizeBytes: a.size_bytes,
          canDownload: true,
        })),
    [visible],
  );
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  async function handleDownload(id: string) {
    try {
      await saveAttachment(id);
    } catch (err) {
      addToast("error", t("errors.attachmentSave"), err instanceof Error ? err.message : String(err));
    }
  }

  if (visible.length === 0) return null;

  return (
    <div className="px-4 py-3 border-t border-border bg-bg-secondary/30">
      <div className="flex items-center gap-2 mb-2">
        <Paperclip className="w-4 h-4 text-text-tertiary" />
        <span className="text-sm font-medium text-text-secondary">
          {t("mailDetail.attachment", { count: visible.length })}
        </span>
      </div>
      <div className="flex flex-wrap gap-2">
        {visible.map((att) => {
          const lightboxIdx = imageItems.findIndex((i) => i.id === att.id);
          return (
            <AttachmentItem
              key={att.id}
              attachment={att}
              onImageClick={lightboxIdx >= 0 ? () => setLightboxIndex(lightboxIdx) : undefined}
            />
          );
        })}
      </div>
      {lightboxIndex !== null && (
        <ImageLightbox
          images={imageItems}
          initialIndex={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
          onDownload={handleDownload}
        />
      )}
    </div>
  );
}

const BASE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    padding: 24px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 15px;
    line-height: 1.6;
    word-wrap: break-word;
    overflow-wrap: break-word;
  }
  img { max-width: 100%; height: auto; cursor: zoom-in; }
  pre, code { white-space: pre-wrap; word-wrap: break-word; font-size: 13px; }
  table { max-width: 100%; border-collapse: collapse; }
  blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid #d1d5db; color: #6b7280; }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb { border-radius: 3px; }
`;

const LIGHT_STYLES = `
  html { background: #ffffff; }
  body { background: #ffffff; color: #1a1a1a; }
  a { color: #2563eb; }
  ::-webkit-scrollbar-thumb { background: #cbd5e1; }
  ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
`;

const DARK_STYLES = `
  html { background: #1e293b; color-scheme: dark; }
  body {
    color: #1a1a1a;
    filter: invert(0.88) hue-rotate(180deg);
  }
  /* Set dark base text color so inversion produces light text.
     No !important, no * — elements with their own inline colors keep them,
     preserving colored text (red warnings, green success, brand colors). */
  a, a * { color: #2563eb !important; }
  /* Re-invert all media so images/videos/SVGs appear in original colors */
  img, video, picture, svg {
    filter: invert(1) hue-rotate(180deg) !important;
  }
  hr { opacity: 0.4; }
  blockquote { border-left-color: #888 !important; }
  ::-webkit-scrollbar-thumb { background: #475569; }
  ::-webkit-scrollbar-thumb:hover { background: #64748b; }
`;

export function HtmlMailFrame({ html, allowExternalImages = true, onIframeRef, onTrackersDetected, onLinkClick, onImageClick }: { html: string; allowExternalImages?: boolean; onIframeRef?: (el: HTMLIFrameElement | null) => void; onTrackersDetected?: (trackers: TrackerInfo[]) => void; onLinkClick?: (href: string) => void; onImageClick?: (src: string) => void }) {
  const darkMode = useAppStore((s) => s.darkMode);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(300);
  const { t } = useTranslation();

  const themeStyles = darkMode ? DARK_STYLES : LIGHT_STYLES;

  // Dark mode overrides go AFTER the email content so they win over
  // any !important rules in the email's own <style> blocks (e.g. Apple Mail)
  const { html: cleanHtml, trackers } = useMemo(
    () => sanitizeEmailHtml(html, allowExternalImages),
    [html, allowExternalImages]
  );

  useEffect(() => {
    onTrackersDetected?.(trackers);
  }, [html, allowExternalImages]);

  // The bridge script is allow-listed by its SHA-256 hash in both this iframe's
  // CSP and the parent CSP (tauri.conf.json); a `srcdoc` iframe inherits the
  // parent's CSP, which the production build enforces. Email scripts carry no
  // matching hash, so `allow-scripts` on the sandbox cannot run them.
  const srcDoc = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="script-src '${MAIL_LINK_BRIDGE_CSP_HASH}'; object-src 'none';"><style>
${BASE_STYLES}
</style></head><body>${cleanHtml}<style>${themeStyles}</style><script>${MAIL_LINK_BRIDGE}</script></body></html>`;

  const resizeIframe = useCallback(() => {
    try {
      const doc = iframeRef.current?.contentDocument;
      if (doc?.body) {
        const h = doc.body.scrollHeight;
        if (h > 0) setHeight(h);
      }
    } catch {}
  }, []);

  useEffect(() => {
    resizeIframe();
  }, [html, darkMode, resizeIframe]);

  // The in-frame LINK_BRIDGE relays clicks here via postMessage. A parent-side
  // listener on the iframe's contentDocument never fires on macOS/WKWebView.
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      const iframe = iframeRef.current;
      if (!iframe || e.source !== iframe.contentWindow) return;
      const data = e.data as { __prudiiLink?: string; __prudiiImage?: string } | null;
      if (!data) return;

      if (typeof data.__prudiiImage === "string") {
        onImageClick?.(data.__prudiiImage);
        return;
      }

      let href = data.__prudiiLink?.trim();
      if (!href || href.startsWith("#")) return;

      if (href.startsWith("//")) {
        href = "https:" + href;
      } else if (!/^[a-z][a-z0-9+.-]*:/i.test(href)) {
        href = "https://" + href;
      }

      if (href.startsWith("mailto:")) {
        if (onLinkClick) {
          onLinkClick(href);
        } else {
          useAppStore.getState().openMailto(href);
        }
      } else if (onLinkClick) {
        onLinkClick(href);
      } else {
        openMailUrl(href).catch((err) => {
          console.warn("Failed to open URL:", href, err);
        });
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onLinkClick, onImageClick]);

  // Forward ref to parent for print
  const setRef = useCallback((el: HTMLIFrameElement | null) => {
    (iframeRef as any).current = el;
    onIframeRef?.(el);
  }, [onIframeRef]);

  return (
    <iframe
      ref={setRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-scripts"
      onLoad={resizeIframe}
      className="w-full border-0"
      style={{
        height: `${height}px`,
        background: darkMode ? "#1e293b" : "#ffffff",
      }}
      title={t("mailDetail.emailContent")}
    />
  );
}

function MailBody({ mail, onIframeRef }: { mail: Mail; onIframeRef?: (el: HTMLIFrameElement | null) => void }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const accounts = useAppStore((s) => s.accounts);
  const [loadedMail, setLoadedMail] = useState<Mail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [viewPlainText, setViewPlainText] = useState(false);
  const [trackers, setTrackers] = useState<TrackerInfo[]>([]);
  const [inlineLightbox, setInlineLightbox] = useState<ImageLightboxItem | null>(null);
  const inlineIndexRef = useRef(0);

  const account = accounts.find((a) => a.id === mail.account_id);
  const allowExternalImages = account?.load_external_images !== "never";

  const handleInlineImageClick = useCallback((src: string) => {
    if (!src.startsWith("data:")) return;
    const idx = ++inlineIndexRef.current;
    setInlineLightbox({
      id: `inline:${idx}`,
      filename: `image-${idx}`,
      src,
      sizeBytes: null,
      canDownload: false,
    });
  }, []);

  const bodyEmpty = !mail.body_html && (!mail.body_text || mail.body_text === "[fetch-failed]");
  const displayMail = loadedMail ?? mail;

  useEffect(() => {
    let cancelled = false;
    setLoadedMail(null);
    setError(null);
    setViewPlainText(false);

    if (bodyEmpty && (mail.uid || mail.message_id)) {
      setLoading(true);
      fetchMailBody(mail.id)
        .then((updated) => {
          if (cancelled) return;
          setLoadedMail(updated);
          setLoading(false);
          // Body fetch also saves attachments — invalidate so AttachmentList refreshes
          queryClient.invalidateQueries({ queryKey: ["attachments", mail.id] });
        })
        .catch((err) => {
          if (cancelled) return;
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [mail.id]);

  if (loading) {
    return <MailDetailSkeleton />;
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-text-tertiary">{error}</p>
      </div>
    );
  }

  const hasBody = displayMail.body_html || (displayMail.body_text && displayMail.body_text !== "[fetch-failed]");

  if (!hasBody) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <p className="text-sm text-text-tertiary">{t("mailDetail.noBody")}</p>
      </div>
    );
  }

  const hasHtml = !!displayMail.body_html;
  const hasText = !!displayMail.body_text;
  const showPlain = viewPlainText || !hasHtml;

  return (
    <>
      {(hasHtml || hasText) && (
        <div className="flex items-center gap-1 px-4 py-1 border-b border-border">
          {hasHtml && hasText && (
            <>
              <button
                onClick={() => setViewPlainText(false)}
                className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs font-medium transition-colors ${
                  !showPlain
                    ? "bg-accent-soft text-accent"
                    : "text-text-tertiary hover:text-text-secondary hover:bg-hover"
                }`}
              >
                <Code className="w-3.5 h-3.5" />
                {t("mailDetail.htmlView")}
              </button>
              <button
                onClick={() => setViewPlainText(true)}
                className={`flex items-center gap-1.5 px-2.5 py-0.5 rounded text-xs font-medium transition-colors ${
                  showPlain
                    ? "bg-accent-soft text-accent"
                    : "text-text-tertiary hover:text-text-secondary hover:bg-hover"
                }`}
              >
                <FileType className="w-3.5 h-3.5" />
                {t("mailDetail.plainText")}
              </button>
            </>
          )}
          <div className="flex-1" />
          <TrackingIndicator trackers={trackers} />
        </div>
      )}
      <div className="flex-1 overflow-y-auto px-4 py-3 scrollbar-thin">
        {showPlain ? (
          <pre className="text-sm text-text-secondary whitespace-pre-wrap font-sans leading-relaxed">
            {displayMail.body_text}
          </pre>
        ) : (
          <HtmlMailFrame html={displayMail.body_html!} allowExternalImages={allowExternalImages} onIframeRef={onIframeRef} onTrackersDetected={setTrackers} onImageClick={handleInlineImageClick} />
        )}
      </div>
      {(displayMail.has_attachments || displayMail.body_html || displayMail.body_text) && <AttachmentList mailId={displayMail.id} />}
      {inlineLightbox && (
        <ImageLightbox
          images={[inlineLightbox]}
          initialIndex={0}
          onClose={() => setInlineLightbox(null)}
          onDownload={() => { /* not reachable: canDownload === false */ }}
        />
      )}
    </>
  );
}

/** Empty mail pane with the time-of-day atmosphere sky behind it. */
function NoSelectionState() {
  const { t } = useTranslation();
  const line = useAtmosphereLine("selectMail");
  return (
    <div className="relative h-full overflow-hidden">
      <DaylightSky />
      <div className="relative z-10 h-full">
        <EmptyState
          title={t("mailDetail.selectEmail")}
          description={line ?? t("mailDetail.selectEmailDesc")}
        />
      </div>
    </div>
  );
}

export function MailDetail() {
  const { t } = useTranslation();
  const mails = useAppStore((s) => s.mails);
  const selectedMailId = useAppStore((s) => s.selectedMailId);
  const setMails = useAppStore((s) => s.setMails);
  const addToast = useAppStore((s) => s.addToast);
  const queryClient = useQueryClient();
  const invalidateMailQueries = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["folders"] });
    queryClient.invalidateQueries({ queryKey: ["all-inbox-mails"] });
    queryClient.invalidateQueries({ queryKey: ["combined-folder-mails"] });
    queryClient.invalidateQueries({ queryKey: ["split-inbox-mails"] });
  }, [queryClient]);
  const contentRef = useRef<HTMLDivElement>(null);
  const [fallbackMail, setFallbackMail] = useState<import("../../types").Mail | null>(null);
  const mailFromList = mails.find((m) => m.id === selectedMailId);
  const mail = mailFromList ?? fallbackMail;

  // Fetch mail from DB if not in the paginated mails list (e.g. after search result click)
  useEffect(() => {
    if (selectedMailId && !mailFromList) {
      setFallbackMail(null);
      getMail(selectedMailId).then((m) => {
        if (m) setFallbackMail(m);
      }).catch(() => {});
    } else {
      setFallbackMail(null);
    }
  }, [selectedMailId, mailFromList]);

  useEffect(() => {
    if (mail && !mail.is_read) {
      markAsRead(mail.id)
        .then(() => {
          if (mailFromList) {
            setMails((prev) => prev.map((m) => (m.id === mail.id ? { ...m, is_read: true } : m)));
          } else {
            setFallbackMail((prev) => prev ? { ...prev, is_read: true } : prev);
          }
          invalidateMailQueries();
        })
        .catch((err) => addToast("error", t("errors.markRead"), err instanceof Error ? err.message : String(err)));
    }
  }, [mail?.id]);

  useEffect(() => {
    if (selectedMailId && contentRef.current) {
      gsap.fromTo(contentRef.current,
        { opacity: 0, x: 24 },
        { opacity: 1, x: 0, duration: 0.3, ease: "power2.out" }
      );
    }
  }, [selectedMailId]);

  if (!mail) {
    return <NoSelectionState />;
  }

  // Always use ThreadView — it handles both single mails and conversations.
  // Single mails display as a thread with one message card.
  return (
    <div ref={contentRef} className="flex flex-col h-full">
      <ThreadView mail={mail} />
    </div>
  );
}
