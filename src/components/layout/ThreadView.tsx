import { useEffect, useState, useRef, useCallback, memo, useMemo } from "react";
import { parseISO } from "date-fns";
import { Reply, ReplyAll, Forward, Archive, Paperclip, FileText, Image, Film, Music, File, Loader2, Download, ChevronDown, ChevronRight, MessageSquare, Copy, Check, Code, Eye, FileType, Printer, MailMinus, ImageOff } from "lucide-react";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import gsap from "gsap";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../../stores/appStore";
import { useAttachments, useToggleStar, useToggleMailFlag } from "../../hooks/useAccounts";
import { useScroller } from "../../hooks/useScroller";
import { openAttachment, saveAttachment, fetchMailBody, trashMail, archiveMail, getThreadMails, markAsRead, unsubscribeMail } from "../../lib/tauri";
import { MAIL_LINK_BRIDGE, MAIL_LINK_BRIDGE_CSP_HASH } from "../../lib/mailLinkBridge";
import { checkLink } from "../../lib/linkChecker";
import { cleanMailUrl, openMailUrl } from "../../lib/trackingParams";
import { ContactAvatar } from "../ui/ContactAvatar";
import { FlagPicker } from "../ui/FlagPicker";
import type { MailFlag } from "../../types";
import { StarIcon, TrashIcon } from "../icons";
import { formatDateTime } from "../../lib/dateUtils";
import { sanitizeEmailHtml, escapeHtml, type TrackerInfo } from "../../lib/sanitize";
import { TrackingIndicator } from "./TrackingIndicator";
import { AiSummaryButton, AiSummaryPanel } from "../ai/AiSummary";
import { AiReplyButton, AiReplySuggestionsPanel } from "../ai/AiReplySuggestions";
import { useDialog } from "../ui/DialogProvider";
import type { Mail, Attachment } from "../../types";
import { useTranslation } from "react-i18next";
import { ImageLightbox, type ImageLightboxItem } from "./ImageLightbox";

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

const AttachmentItem = memo(function AttachmentItem({
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

  const handleOpen = useCallback(() => {
    if (isImage && onImageClick) {
      onImageClick();
      return;
    }
    openAttachment(attachment.id).catch((err) => {
      addToast("error", t("errors.attachmentOpen"), err instanceof Error ? err.message : String(err));
    });
  }, [attachment.id, addToast, t, isImage, onImageClick]);

  const handleSave = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSaving(true);
    try {
      await saveAttachment(attachment.id);
    } catch (err) {
      addToast("error", t("errors.attachmentSave"), err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [attachment.id, addToast, t]);

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-hover transition-colors group text-xs">
      <button
        onClick={handleOpen}
        className="flex items-center gap-1.5 text-left min-w-0 flex-1"
      >
        {isImage && attachment.local_path ? (
          <div className="w-12 h-12 rounded overflow-hidden shrink-0 bg-hover">
            <img src={convertFileSrc(attachment.local_path)} alt="" className="w-full h-full object-cover" loading="lazy" />
          </div>
        ) : (
          <Icon className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
        )}
        <span className="text-text truncate">{attachment.filename}</span>
        {attachment.size_bytes && (
          <span className="text-text-tertiary shrink-0">
            {formatFileSize(attachment.size_bytes)}
          </span>
        )}
      </button>
      <button
        onClick={handleSave}
        disabled={saving}
        className="p-1 rounded hover:bg-hover transition-colors opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text disabled:opacity-50"
        aria-label={t("mailDetail.saveAttachment")}
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
});

const AttachmentList = memo(function AttachmentList({ mailId }: { mailId: string }) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const { data: attachments } = useAttachments(mailId);

  const visible = useMemo(() => attachments?.filter((a) => !a.is_inline) ?? [], [attachments]);
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

  const handleDownload = useCallback(async (id: string) => {
    try {
      await saveAttachment(id);
    } catch (err) {
      addToast("error", t("errors.attachmentSave"), err instanceof Error ? err.message : String(err));
    }
  }, [addToast, t]);

  if (visible.length === 0) return null;

  return (
    <div className="mt-3 pt-3 border-t border-border-light">
      <div className="flex items-center gap-1.5 mb-2">
        <Paperclip className="w-3.5 h-3.5 text-text-tertiary" />
        <span className="text-xs font-medium text-text-secondary">
          {t("mailDetail.attachment", { count: visible.length })}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
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
});

async function ensureBodies(mails: Mail[]): Promise<Mail[]> {
  return Promise.all(
    mails.map(async (m) => {
      if (m.body_html || m.body_text) return m;
      if (!m.uid && !m.message_id) return m;
      try {
        return await fetchMailBody(m.id);
      } catch {
        return m;
      }
    })
  );
}

function printMails(mails: Mail[]) {
  const iframe = document.createElement("iframe");
  iframe.style.cssText = "position:fixed;left:-9999px;top:-9999px;width:0;height:0;border:none";
  document.body.appendChild(iframe);
  const doc = iframe.contentDocument || iframe.contentWindow?.document;
  if (!doc) { document.body.removeChild(iframe); return; }

  const messages = mails.map((m) => {
    const from = m.from.name ? `${escapeHtml(m.from.name)} &lt;${escapeHtml(m.from.email)}&gt;` : escapeHtml(m.from.email);
    const to = m.to.map((r) => r.name ? `${escapeHtml(r.name)} &lt;${escapeHtml(r.email)}&gt;` : escapeHtml(r.email)).join(", ");
    const cc = m.cc.length > 0 ? m.cc.map((r) => r.name ? `${escapeHtml(r.name)} &lt;${escapeHtml(r.email)}&gt;` : escapeHtml(r.email)).join(", ") : "";
    const rawDate = new Date(m.date);
    const date = isNaN(rawDate.getTime()) ? (m.date || "") : rawDate.toLocaleString();
    const body = m.body_html ? sanitizeEmailHtml(m.body_html, false).html : (m.body_text ? `<pre style="white-space:pre-wrap;font-family:inherit">${escapeHtml(m.body_text)}</pre>` : "<p style='color:#999'>—</p>");

    return `<div class="message">
      <div class="header">
        <div class="subject">${escapeHtml(m.subject)}</div>
        <table class="meta"><tbody>
          <tr><td class="label">Von:</td><td>${from}</td></tr>
          <tr><td class="label">An:</td><td>${to}</td></tr>
          ${cc ? `<tr><td class="label">Cc:</td><td>${cc}</td></tr>` : ""}
          <tr><td class="label">Datum:</td><td>${escapeHtml(date)}</td></tr>
        </tbody></table>
      </div>
      <div class="body">${body}</div>
    </div>`;
  }).join('<hr class="separator">');

  doc.open();
  doc.write(`<!DOCTYPE html><html><head><meta charset="utf-8"><title>${escapeHtml(mails[0]?.subject || "")}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; }
  body { margin: 0; padding: 32px 40px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; font-size: 13px; line-height: 1.6; color: #1a1a1a; background: #fff; }
  .message { margin-bottom: 24px; }
  .header { margin-bottom: 16px; padding-bottom: 12px; border-bottom: 1px solid #e5e7eb; }
  .subject { font-size: 17px; font-weight: 600; margin-bottom: 8px; color: #111; }
  .meta { font-size: 12px; color: #4b5563; border-collapse: collapse; }
  .meta td { padding: 1px 0; vertical-align: top; }
  .meta .label { font-weight: 600; color: #6b7280; padding-right: 10px; white-space: nowrap; }
  .body { font-size: 14px; line-height: 1.6; }
  .body img { max-width: 100%; height: auto; }
  .body table { max-width: 100%; border-collapse: collapse; }
  .body blockquote { margin: 8px 0; padding-left: 12px; border-left: 3px solid #d1d5db; color: #6b7280; }
  .body pre, .body code { white-space: pre-wrap; word-wrap: break-word; font-size: 12px; }
  .body a { color: #2563eb; }
  hr.separator { border: none; border-top: 1px solid #d1d5db; margin: 24px 0; }
  @media print {
    body { padding: 0; }
    .message { page-break-inside: avoid; }
  }
</style></head><body>${messages}</body></html>`);
  doc.close();

  // Wait for images to load, then print
  setTimeout(() => {
    try { iframe.contentWindow?.print(); } catch {}
    setTimeout(() => document.body.removeChild(iframe), 500);
  }, 300);
}

const BASE_STYLES = `
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    padding: 16px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
    font-size: 14px;
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
  html { background: transparent; }
  body { background: transparent; color: #1a1a1a; }
  a { color: #2563eb; }
  ::-webkit-scrollbar-thumb { background: #cbd5e1; }
  ::-webkit-scrollbar-thumb:hover { background: #94a3b8; }
`;

const DARK_STYLES = `
  html { background: transparent; color-scheme: dark; }
  body {
    color: #1a1a1a;
    filter: invert(0.88) hue-rotate(180deg);
  }
  a, a * { color: #2563eb !important; }
  img, video, picture, svg {
    filter: invert(1) hue-rotate(180deg) !important;
  }
  hr { opacity: 0.4; }
  blockquote { border-left-color: #888 !important; }
  ::-webkit-scrollbar-thumb { background: #475569; }
  ::-webkit-scrollbar-thumb:hover { background: #64748b; }
`;

const HtmlMailFrame = memo(function HtmlMailFrame({ html, allowExternalImages = true, onIframeRef, onTrackersDetected, onLinkClick, onImageClick }: { html: string; allowExternalImages?: boolean; onIframeRef?: (el: HTMLIFrameElement | null) => void; onTrackersDetected?: (trackers: TrackerInfo[]) => void; onLinkClick?: (href: string) => void; onImageClick?: (src: string) => void }) {
  const darkMode = useAppStore((s) => s.darkMode);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(300);
  const { t } = useTranslation();

  const themeStyles = darkMode ? DARK_STYLES : LIGHT_STYLES;

  const { html: cleanHtml, trackers } = useMemo(
    () => sanitizeEmailHtml(html, allowExternalImages),
    [html, allowExternalImages]
  );

  useEffect(() => {
    if (onTrackersDetected && trackers.length > 0) {
      onTrackersDetected(trackers);
    }
  }, [html, allowExternalImages]);

  // The bridge script is allow-listed by its SHA-256 hash in both this iframe's
  // CSP and the parent CSP (tauri.conf.json) — a `srcdoc` iframe inherits the
  // parent's CSP, and the production build enforces it. The email's own scripts
  // carry no matching hash, so `allow-scripts` on the sandbox cannot run them.
  const srcDoc = useMemo(
    () =>
      `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="script-src '${MAIL_LINK_BRIDGE_CSP_HASH}'; object-src 'none';"><style>
${BASE_STYLES}
</style></head><body>${cleanHtml}<style>${themeStyles}</style><script>${MAIL_LINK_BRIDGE}</script></body></html>`,
    [cleanHtml, themeStyles]
  );

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

  // The in-frame LINK_BRIDGE relays clicks here via postMessage (a parent-side
  // listener on the iframe's contentDocument never fires on macOS/WKWebView).
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
        openMailUrl(href).catch(() => {});
      }
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onLinkClick, onImageClick]);

  useEffect(() => {
    if (onIframeRef) onIframeRef(iframeRef.current);
  }, [onIframeRef]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin allow-scripts"
      style={{ width: "100%", height, border: "none", overflow: "hidden", background: "transparent" }}
      onLoad={resizeIframe}
      title={t("mailDetail.emailContent")}
    />
  );
});

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

interface MessageCardProps {
  mail: Mail;
  isLatest: boolean;
  isSelected?: boolean;
  singleMail?: boolean;
  onReply: (mail: Mail) => void;
  onReplyAll: (mail: Mail) => void;
  onForward: (mail: Mail) => void;
  onIframeRef?: (el: HTMLIFrameElement | null) => void;
  onLinkClick?: (href: string) => void;
  onUpdateMail?: (mailId: string, updates: Partial<Mail>) => void;
}

const MessageCard = memo(function MessageCard({ mail, isLatest, isSelected, singleMail, onReply, onReplyAll, onForward, onIframeRef, onLinkClick, onUpdateMail }: MessageCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(isLatest || !!isSelected || !!singleMail);
  const [loadedMail, setLoadedMail] = useState<Mail | null>(null);
  const [loading, setLoading] = useState(false);
  const setMails = useAppStore((s) => s.setMails);
  const appSettings = useAppStore((s) => s.appSettings);
  const accounts = useAppStore((s) => s.accounts);
  const toggleStarMutation = useToggleStar();
  const toggleFlagMutation = useToggleMailFlag();
  const contentRef = useRef<HTMLDivElement>(null);
  const [inlineLightbox, setInlineLightbox] = useState<ImageLightboxItem | null>(null);
  const inlineIndexRef = useRef(0);

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

  const displayMail = loadedMail ?? mail;
  const bodyEmpty = !mail.body_html && !mail.body_text;

  const [bodyError, setBodyError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (expanded && bodyEmpty && (mail.uid || mail.message_id) && !loading && !loadedMail && !bodyError) {
      setLoading(true);
      fetchMailBody(mail.id)
        .then((updated) => {
          if (cancelled) return;
          setLoadedMail(updated);
          setLoading(false);
          // Body fetch also saves attachments — invalidate so AttachmentList refreshes
          queryClient.invalidateQueries({ queryKey: ["attachments", mail.id] });
          // Propagate body-loaded state to parent so ThreadAttachments can see this mail's attachments
          onUpdateMail?.(mail.id, { body_html: updated.body_html, body_text: updated.body_text, has_attachments: updated.has_attachments });
        })
        .catch((err) => {
          if (cancelled) return;
          console.error("Failed to fetch body:", err);
          setBodyError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [expanded, mail.id]);

  const updateMail = useCallback((updates: Partial<Mail>) => {
    setMails((prev) => prev.map((m) => (m.id === mail.id ? { ...m, ...updates } : m)));
    onUpdateMail?.(mail.id, updates);
  }, [setMails, mail.id, onUpdateMail]);

  const handleStar = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    const prev = mail.is_starred;
    updateMail({ is_starred: !prev });
    toggleStarMutation.mutate(mail.id, {
      onError: () => updateMail({ is_starred: prev }),
    });
  }, [mail.id, mail.is_starred, updateMail, toggleStarMutation]);

  const handleToggle = useCallback(() => setExpanded(prev => !prev), []);
  const handleReply = useCallback(() => onReply(displayMail), [onReply, displayMail]);
  const handleReplyAll = useCallback(() => onReplyAll(displayMail), [onReplyAll, displayMail]);
  const handleForward = useCallback(() => onForward(displayMail), [onForward, displayMail]);

  const handleToggleFlag = useCallback((flag: MailFlag) => {
    const prevFlags = mail.flags || [];
    const newFlags = prevFlags.includes(flag)
      ? prevFlags.filter((f) => f !== flag)
      : [...prevFlags, flag];
    updateMail({ flags: newFlags });
    toggleFlagMutation.mutate({ mailId: mail.id, flag }, {
      onError: () => updateMail({ flags: prevFlags }),
    });
  }, [mail.id, mail.flags, updateMail, toggleFlagMutation]);

  const messageIframeRef = useRef<HTMLIFrameElement | null>(null);
  const handlePrint = useCallback(async () => {
    const [withBody] = await ensureBodies([displayMail]);
    printMails([withBody]);
  }, [displayMail]);

  const [viewPlainText, setViewPlainText] = useState(false);
  const [trackers, setTrackers] = useState<TrackerInfo[]>([]);
  const [allowImagesOverride, setAllowImagesOverride] = useState(false);
  const hasBody = displayMail.body_html || displayMail.body_text;
  const hasBothFormats = !!displayMail.body_html && !!displayMail.body_text;

  const accountAllowsImages = useMemo(() => {
    const acct = accounts.find((a) => a.id === mail.account_id);
    return acct?.load_external_images !== "never";
  }, [accounts, mail.account_id]);

  const allowExternalImages = allowImagesOverride || accountAllowsImages;

  // Reset per-message image override when navigating to a different mail
  useEffect(() => {
    setAllowImagesOverride(false);
  }, [mail.id]);

  const incrementTrackersBlocked = useAppStore((s) => s.incrementTrackersBlocked);

  const handleTrackersDetected = useCallback((detected: TrackerInfo[]) => {
    setTrackers(detected);
    if (detected.length > 0) incrementTrackersBlocked(detected.length);
  }, [incrementTrackersBlocked]);

  const hasExternalImages = useMemo(() => {
    if (!displayMail.body_html) return false;
    return /<img[^>]+src=["']https?:\/\//i.test(displayMail.body_html);
  }, [displayMail.body_html]);

  const formattedDate = useMemo(() =>
    formatDateTime(parseISO(mail.date), appSettings.use_24h_clock)
  , [mail.date, appSettings.use_24h_clock]);

  const recipients = useMemo(() =>
    mail.to.map((t) => t.name || t.email).join(", ")
  , [mail.to]);

  const ccRecipients = useMemo(() =>
    mail.cc.length > 0 ? mail.cc.map((c) => c.name || c.email).join(", ") : null
  , [mail.cc]);

  return (
    <div className={`bg-surface border border-border rounded-xl overflow-hidden transition-shadow ${!singleMail && isLatest ? "ring-2 ring-accent/30" : ""}`}>
      <div
        role={singleMail ? undefined : "button"}
        tabIndex={singleMail ? undefined : 0}
        onClick={singleMail ? undefined : handleToggle}
        onKeyDown={singleMail ? undefined : (e) => { if (e.key === "Enter" || e.key === " ") handleToggle(); }}
        className={`w-full px-4 py-3 flex items-center gap-3 text-left transition-colors ${singleMail ? "" : "hover:bg-hover/50 cursor-pointer"}`}
      >
        {/* Avatar (only in single-mail mode; thread mode shows avatar in timeline) */}
        {singleMail && (
          <ContactAvatar name={mail.from.name} email={mail.from.email} size={36} className="shrink-0" />
        )}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-medium text-text text-sm truncate">
              {mail.from.name || mail.from.email}
            </span>
            {!singleMail && isLatest && (
              <span className="px-1.5 py-0.5 text-[10px] font-medium bg-accent/10 text-accent rounded">
                {t("mailDetail.latest")}
              </span>
            )}
            {mail.has_attachments && (
              <Paperclip className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
            )}
            {!mail.is_read && (
              <span className="w-2 h-2 rounded-full bg-accent shrink-0" />
            )}
          </div>
          <div className="text-xs text-text-tertiary truncate">
            {formattedDate}
            {!expanded && mail.snippet && (
              <span className="ml-2 text-text-secondary">— {mail.snippet}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <FlagPicker flags={mail.flags || []} onToggleFlag={handleToggleFlag} size="sm" />
          <button
            onClick={handleStar}
            className={`p-1.5 rounded-lg hover:bg-hover transition-colors ${
              mail.is_starred ? "text-warning" : "text-text-tertiary"
            }`}
          >
            <StarIcon size={14} strokeWidth={1.5} color={mail.is_starred ? "var(--c-warning)" : "currentColor"} />
          </button>
          {!singleMail && (
            <div className={`transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}>
              <ChevronDown className="w-4 h-4 text-text-tertiary" />
            </div>
          )}
        </div>
      </div>

      <div
        ref={contentRef}
        className={singleMail ? "" : `transition-all duration-200 ease-out overflow-hidden ${expanded ? "opacity-100" : "opacity-0 h-0"}`}
        style={singleMail ? undefined : { maxHeight: expanded ? "none" : 0 }}
      >
        <div className="px-4 pb-4 border-t border-border-light">
          <div className="py-2 text-xs text-text-tertiary">
            <div className="flex items-center gap-1.5 mb-0.5">
              <span className="text-text-secondary font-medium">{mail.from.name || mail.from.email}</span>
              <span>&lt;{mail.from.email}&gt;</span>
              <CopyEmailButton email={mail.from.email} />
            </div>
            <span>To: {recipients}</span>
            {ccRecipients && (
              <span className="ml-2">Cc: {ccRecipients}</span>
            )}
          </div>

          {loading ? (
            <div className="py-8 flex items-center justify-center">
              <Loader2 className="w-5 h-5 text-accent animate-spin" />
            </div>
          ) : bodyError ? (
            <div className="py-4 text-center">
              <p className="text-sm text-danger">{bodyError}</p>
            </div>
          ) : hasBody ? (
            <div className="prose-sm">
              {(hasBothFormats || !!displayMail.body_html) && (
                <div className="flex items-center gap-1 mb-2">
                  {hasBothFormats && (
                    <>
                      <button
                        onClick={() => setViewPlainText(false)}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                          !viewPlainText
                            ? "bg-accent-soft text-accent"
                            : "text-text-tertiary hover:text-text-secondary hover:bg-hover"
                        }`}
                      >
                        <Code className="w-3.5 h-3.5" />
                        {t("mailDetail.htmlView")}
                      </button>
                      <button
                        onClick={() => setViewPlainText(true)}
                        className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
                          viewPlainText
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
              {hasExternalImages && !allowExternalImages && (
                <div className="flex items-center justify-between gap-3 px-4 py-2 mb-2 bg-bg-secondary border border-border rounded-lg text-xs text-text-secondary">
                  <div className="flex items-center gap-2">
                    <ImageOff className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
                    <span>{t("mailDetail.imagesBlocked.message")}</span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setAllowImagesOverride(true)}
                    className="px-2 py-1 rounded hover:bg-hover transition-colors text-accent font-medium shrink-0"
                  >
                    {t("mailDetail.imagesBlocked.load")}
                  </button>
                </div>
              )}
              {displayMail.body_html && !viewPlainText ? (
                <HtmlMailFrame html={displayMail.body_html} allowExternalImages={allowExternalImages} onIframeRef={(el) => { messageIframeRef.current = el; onIframeRef?.(el); }} onTrackersDetected={handleTrackersDetected} onLinkClick={onLinkClick} onImageClick={handleInlineImageClick} />
              ) : (
                <pre className="text-sm text-text-secondary whitespace-pre-wrap font-sans leading-relaxed">
                  {displayMail.body_text}
                </pre>
              )}
            </div>
          ) : (
            <p className="py-4 text-sm text-text-tertiary text-center">{t("mailDetail.noContent")}</p>
          )}

          {/* Attachments — show when flag is set OR body is loaded (flag from header sync
              can be inaccurate, but body-loaded mails may have undiscovered attachments) */}
          {(displayMail.has_attachments || displayMail.body_html || displayMail.body_text) && <AttachmentList mailId={displayMail.id} />}

          {inlineLightbox && (
            <ImageLightbox
              images={[inlineLightbox]}
              initialIndex={0}
              onClose={() => setInlineLightbox(null)}
              onDownload={() => { /* not reachable: canDownload === false */ }}
            />
          )}

          <div className="mt-3 pt-3 border-t border-border-light flex items-center gap-2">
            <button
              onClick={handleReply}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover transition-colors"
            >
              <Reply className="w-3.5 h-3.5" />
              {t("mailDetail.reply")}
            </button>
            <button
              onClick={handleReplyAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover transition-colors"
            >
              <ReplyAll className="w-3.5 h-3.5" />
              {t("mailDetail.replyAll")}
            </button>
            <button
              onClick={handleForward}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover transition-colors"
            >
              <Forward className="w-3.5 h-3.5" />
              {t("mailDetail.forward")}
            </button>
            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover transition-colors"
            >
              <Printer className="w-3.5 h-3.5" />
              {t("mailDetail.print")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
});

interface ThreadAttachmentItemProps {
  attachment: Attachment;
  senderName: string;
}

const ThreadAttachmentItem = memo(function ThreadAttachmentItem({ attachment, senderName }: ThreadAttachmentItemProps) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const Icon = getFileIcon(attachment.mime_type);
  const [saving, setSaving] = useState(false);

  const handleOpen = useCallback(() => {
    openAttachment(attachment.id).catch((err) => {
      addToast("error", t("errors.attachmentOpen"), err instanceof Error ? err.message : String(err));
    });
  }, [attachment.id, addToast, t]);

  const handleSave = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    setSaving(true);
    try {
      await saveAttachment(attachment.id);
    } catch (err) {
      addToast("error", t("errors.attachmentSave"), err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [attachment.id, addToast, t]);

  return (
    <div className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-hover transition-colors group text-xs">
      <button
        onClick={handleOpen}
        className="flex items-center gap-2 text-left min-w-0 flex-1"
      >
        <Icon className="w-4 h-4 text-text-tertiary shrink-0" />
        <div className="min-w-0 flex-1">
          <span className="text-text truncate block">{attachment.filename}</span>
          <span className="text-text-tertiary text-[11px]">
            {senderName}
            {attachment.size_bytes ? ` · ${formatFileSize(attachment.size_bytes)}` : ""}
          </span>
        </div>
      </button>
      <button
        onClick={handleSave}
        disabled={saving}
        className="p-1 rounded hover:bg-hover transition-colors opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text disabled:opacity-50"
        aria-label={t("mailDetail.saveAttachment")}
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
});

interface ThreadAttachmentsProps {
  threadMails: Mail[];
  loading: boolean;
}

const ThreadAttachments = memo(function ThreadAttachments({ threadMails, loading }: ThreadAttachmentsProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);

  const mailsWithAttachments = useMemo(
    () => threadMails.filter((m) => m.has_attachments),
    [threadMails]
  );

  const totalCount = mailsWithAttachments.length;
  if (totalCount === 0) return null;

  const pendingBodies = mailsWithAttachments.filter(
    (m) => !m.body_html && !m.body_text
  ).length;
  const allBodiesLoaded = pendingBodies === 0 && !loading;

  return (
    <div className="border-b border-border bg-surface">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className="w-full px-6 py-2 flex items-center gap-2 text-xs text-text-secondary hover:bg-hover/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-text-tertiary" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-text-tertiary" />
        )}
        <Paperclip className="w-3.5 h-3.5 text-text-tertiary" />
        <span className="font-medium">
          {t("mailDetail.messagesWithAttachments", { count: totalCount })}
        </span>
        {!allBodiesLoaded && (
          <Loader2 className="w-3 h-3 animate-spin text-text-tertiary" />
        )}
      </button>

      {expanded && (
        <ThreadAttachmentsContent
          mailsWithAttachments={mailsWithAttachments}
          allBodiesLoaded={allBodiesLoaded}
        />
      )}
    </div>
  );
});

interface ThreadAttachmentsContentProps {
  mailsWithAttachments: Mail[];
  allBodiesLoaded: boolean;
}

const ThreadAttachmentsContent = memo(function ThreadAttachmentsContent({
  mailsWithAttachments,
  allBodiesLoaded,
}: ThreadAttachmentsContentProps) {
  const { t } = useTranslation();
  const mailsReady = mailsWithAttachments.filter((m) => m.body_html || m.body_text);

  return (
    <div className="px-6 pb-3">
      {mailsReady.map((m) => (
        <MailAttachmentGroup key={m.id} mail={m} />
      ))}
      {!allBodiesLoaded && (
        <div className="flex items-center gap-2 py-2 text-xs text-text-tertiary">
          <Loader2 className="w-3 h-3 animate-spin" />
          <span>{t("mailDetail.loadingAttachments")}</span>
        </div>
      )}
    </div>
  );
});

const MailAttachmentGroup = memo(function MailAttachmentGroup({ mail }: { mail: Mail }) {
  const { data: attachments } = useAttachments(mail.id);
  const visible = useMemo(() => attachments?.filter((a) => !a.is_inline) ?? [], [attachments]);
  const senderName = mail.from.name || mail.from.email;

  if (visible.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {visible.map((att) => (
        <ThreadAttachmentItem key={att.id} attachment={att} senderName={senderName} />
      ))}
    </div>
  );
});

function ThreadMessages({
  threadMails,
  isSingleMail,
  loading,
  selectedMailId,
  onReply,
  onReplyAll,
  onForward,
  onLinkClick,
  onUpdateMail,
}: {
  threadMails: Mail[];
  isSingleMail: boolean;
  loading: boolean;
  selectedMailId?: string;
  onReply: (mail: Mail) => void;
  onReplyAll: (mail: Mail) => void;
  onForward: (mail: Mail) => void;
  onLinkClick: (href: string) => void;
  onUpdateMail: (mailId: string, updates: Partial<Mail>) => void;
}) {
  const messagesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!messagesRef.current || loading || threadMails.length === 0) return;
    const cards = messagesRef.current.querySelectorAll(".message-card");
    if (cards.length === 0) return;
    gsap.fromTo(cards,
      { opacity: 0, y: 16, scale: 0.98 },
      { opacity: 1, y: 0, scale: 1, stagger: 0.06, duration: 0.3, ease: "back.out(1.2)" }
    );
  }, [loading, threadMails.length]);

  return (
    <div ref={messagesRef} className={isSingleMail ? "space-y-3" : "space-y-4"}>
      {threadMails.map((m, index) => (
        <div key={m.id} className="message-card flex gap-3" style={{ opacity: 0 }}>
          {!isSingleMail && (
            <div className="flex flex-col items-center shrink-0 pt-3">
              <ContactAvatar name={m.from.name} email={m.from.email} size={28} />
              {index < threadMails.length - 1 && (
                <div className="w-0.5 flex-1 bg-border mt-2 min-h-[16px]" />
              )}
            </div>
          )}
          <div className="flex-1 min-w-0">
            <MessageCard
              mail={m}
              isLatest={index === 0}
              isSelected={m.id === selectedMailId}
              singleMail={isSingleMail}
              onReply={onReply}
              onReplyAll={onReplyAll}
              onForward={onForward}
              onLinkClick={onLinkClick}
              onUpdateMail={onUpdateMail}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

interface ThreadViewProps {
  mail: Mail;
}

export function ThreadView({ mail }: ThreadViewProps) {
  const { t } = useTranslation();
  const messagesScrollRef = useScroller<HTMLDivElement>();
  const [threadMails, setThreadMails] = useState<Mail[]>([mail]);
  const [loading, setLoading] = useState(true);
  const openCompose = useAppStore((s) => s.openCompose);
  const mails = useAppStore((s) => s.mails);
  const setMails = useAppStore((s) => s.setMails);
  const setSelectedMailId = useAppStore((s) => s.setSelectedMailId);
  const selectedMailIndex = useAppStore((s) => s.selectedMailIndex);
  const setPendingRemoveId = useAppStore((s) => s.setPendingRemoveId);
  const folders = useAppStore((s) => s.folders);
  const selectedFolderId = useAppStore((s) => s.selectedFolderId);
  const addToast = useAppStore((s) => s.addToast);
  const queryClient = useQueryClient();
  const dialog = useDialog();
  const currentFolder = folders.find((f) => f.id === selectedFolderId);
  const isInTrash = currentFolder?.folder_type === "trash";
  const [showAiSummary, setShowAiSummary] = useState(false);
  const [showAiReplies, setShowAiReplies] = useState(false);

  const handlePrint = useCallback(async () => {
    const withBodies = await ensureBodies(threadMails);
    printMails(withBodies);
  }, [threadMails]);

  useEffect(() => {
    if (mail && !mail.is_read) {
      markAsRead(mail.id)
        .then(() => {
          setMails((prev) => prev.map((m) => (m.id === mail.id ? { ...m, is_read: true } : m)));

          queryClient.invalidateQueries({ queryKey: ["folders"] });
        })
        .catch((err) => addToast("error", t("errors.markRead"), err instanceof Error ? err.message : String(err)));
    }
  }, [mail.id]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    getThreadMails(mail.id)
      .then((fetchedMails) => {
        if (cancelled) return;
        const sorted = fetchedMails.sort((a, b) => (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0));
        setThreadMails(sorted.length > 0 ? sorted : [mail]);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        addToast("error", t("errors.threadLoad"), err instanceof Error ? err.message : String(err));
        setThreadMails([mail]);
        setLoading(false);
      });

    return () => { cancelled = true; };
  }, [mail.id]);

  // Re-fetch thread when sync completes (e.g. after sending a reply)
  useEffect(() => {
    const unlisten = listen<{ status: string }>("sync-progress", (event) => {
      if (event.payload.status !== "done") return;
      getThreadMails(mail.id).then((fetchedMails) => {
        const sorted = fetchedMails.sort((a, b) =>
          (new Date(b.date).getTime() || 0) - (new Date(a.date).getTime() || 0)
        );
        setThreadMails(sorted.length > 0 ? sorted : [mail]);
      }).catch(() => {});
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [mail.id]);

  const selectNextMail = useCallback(() => {
    const remaining = mails.filter((m) => m.id !== mail.id);
    if (remaining.length === 0) {
      setSelectedMailId(null);
    } else {
      const nextIndex = Math.min(selectedMailIndex, remaining.length - 1);
      setSelectedMailId(remaining[nextIndex].id);
    }
    setMails(remaining);
  }, [mails, mail.id, setSelectedMailId, selectedMailIndex, setMails]);

  const handleTrash = useCallback(async () => {
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
      .then(() => queryClient.invalidateQueries({ queryKey: ["folders"] }))
      .catch((e) => {
        dialog.alert({ type: "danger", title: t("common.error"), message: String(e) });
      });
  }, [mail.id, mail.subject, isInTrash, selectNextMail, dialog, t, queryClient]);

  const handleArchive = useCallback(async () => {
    setPendingRemoveId(mail.id);
    archiveMail(mail.id)
      .then(() => queryClient.invalidateQueries({ queryKey: ["folders"] }))
      .catch((e) => {
        dialog.alert({ type: "danger", title: t("common.error"), message: String(e) });
      });
  }, [mail.id, setPendingRemoveId, dialog, t, queryClient]);

  const handleUpdateThreadMail = useCallback((mailId: string, updates: Partial<Mail>) => {
    setThreadMails((prev) => prev.map((m) => (m.id === mailId ? { ...m, ...updates } : m)));
  }, []);

  const handleReply = useCallback((targetMail: Mail) => {
    openCompose("reply", targetMail);
  }, [openCompose]);

  const handleReplyAll = useCallback((targetMail: Mail) => {
    openCompose("replyAll", targetMail);
  }, [openCompose]);

  const handleForward = useCallback((targetMail: Mail) => {
    openCompose("forward", targetMail);
  }, [openCompose]);

  const handleLinkClick = useCallback((href: string) => {
    if (href.startsWith("mailto:")) {
      useAppStore.getState().openMailto(href);
      return;
    }
    const cleaned = cleanMailUrl(href);
    const result = checkLink(cleaned);
    if (result.safe) {
      openUrl(cleaned).catch(() => {});
      return;
    }
    const warningLines = result.warnings.map((w) => `• ${t(`linkCheck.${w.type}`)}: ${w.detail}`).join("\n");
    dialog.danger({
      title: t("linkCheck.suspiciousLink"),
      message: `${t("linkCheck.warningMessage")}\n\n${warningLines}\n\n${cleaned}`,
      confirmLabel: t("linkCheck.openAnyway"),
    }).then((confirmed) => {
      if (confirmed) openUrl(cleaned).catch(() => {});
    });
  }, [dialog, t]);

  const handleUnsubscribe = useCallback(async () => {
    const confirmed = await dialog.danger({
      title: t("unsubscribe.title"),
      message: t("unsubscribe.confirmMessage"),
    });
    if (!confirmed) return;
    try {
      const result = await unsubscribeMail(mail.id);
      if (result.method === "one_click" && result.success) {
        dialog.alert({ type: "info", title: t("unsubscribe.success"), message: t("unsubscribe.successMessage") });
      } else if (result.method === "browser") {
        openUrl(result.url).catch(() => {});
        dialog.alert({ type: "info", title: t("unsubscribe.title"), message: t("unsubscribe.browserOpened") });
      } else if (result.method === "mailto") {
        openUrl(result.url).catch(() => {});
      }
    } catch (e) {
      dialog.alert({ type: "danger", title: t("common.error"), message: String(e) });
    }
  }, [mail.id, dialog, t]);

  const threadMailIdsKey = useMemo(
    () => threadMails.map((m) => m.id).join(","),
    [threadMails]
  );

  // Prefetch bodies for mails with attachments (max 3 concurrent)
  useEffect(() => {
    if (loading) return;

    const needsFetch = threadMails.filter(
      (m) => m.has_attachments && !m.body_html && !m.body_text && (m.uid || m.message_id)
    );
    if (needsFetch.length === 0) return;

    let cancelled = false;

    async function prefetch() {
      const queue = [...needsFetch];
      const workers = Array.from({ length: Math.min(3, queue.length) }, async () => {
        while (queue.length > 0 && !cancelled) {
          const m = queue.shift()!;
          try {
            const updated = await fetchMailBody(m.id);
            if (cancelled) return;
            setThreadMails((prev) =>
              prev.map((p) => (p.id === m.id ? updated : p))
            );
            queryClient.invalidateQueries({ queryKey: ["attachments", m.id] });
          } catch (err) {
            console.error("Prefetch body failed for", m.id, err);
          }
        }
      });
      await Promise.all(workers);
    }

    prefetch();
    return () => { cancelled = true; };
  }, [loading, threadMailIdsKey]);

  const latestMail = threadMails[0];
  const threadCount = threadMails.length;
  const isSingleMail = !loading && threadCount <= 1;

  return (
    <div className="flex flex-col h-full bg-bg-secondary">
      <div className="px-6 py-4 bg-surface border-b border-border">
        <h2 className="text-lg font-semibold text-text truncate">{mail.subject}</h2>
        {!isSingleMail && (
          <div className="flex items-center gap-2 mt-1">
            <MessageSquare className="w-4 h-4 text-text-tertiary" />
            <span className="text-sm text-text-secondary">
              {t("mailDetail.message", { count: threadCount })}
            </span>
          </div>
        )}
      </div>

      {showAiSummary && <AiSummaryPanel mailId={mail.id} threadMode={!isSingleMail} />}
      {showAiReplies && <AiReplySuggestionsPanel mailId={latestMail.id} threadMode={!isSingleMail} />}

      {!isSingleMail && <ThreadAttachments threadMails={threadMails} loading={loading} />}

      <div ref={messagesScrollRef} className="relative flex-1 overflow-y-auto px-4 pt-1 pb-4">
        <div className="sticky top-1 z-20 flex justify-center pointer-events-none mb-3">
          <div className="inline-flex items-center gap-0.5 px-2 py-1.5 rounded-xl bg-surface/90 backdrop-blur-md border border-border shadow-lg pointer-events-auto">
            <button
              title={t("mailDetail.reply")}
              aria-label={t("mailDetail.reply")}
              onClick={() => openCompose("reply", mail)}
              className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
            >
              <Reply className="w-4 h-4" />
            </button>
            <button
              title={t("mailDetail.replyAll")}
              aria-label={t("mailDetail.replyAll")}
              onClick={() => openCompose("replyAll", mail)}
              className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
            >
              <ReplyAll className="w-4 h-4" />
            </button>
            <button
              title={t("mailDetail.forward")}
              aria-label={t("mailDetail.forward")}
              onClick={() => openCompose("forward", mail)}
              className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
            >
              <Forward className="w-4 h-4" />
            </button>
            <button
              title={t("mailDetail.print")}
              aria-label={t("mailDetail.print")}
              onClick={handlePrint}
              className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
            >
              <Printer className="w-4 h-4" />
            </button>
            <button
              title={t("mailDetail.archiveConversation")}
              aria-label={t("mailDetail.archiveConversation")}
              onClick={handleArchive}
              className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
            >
              <Archive className="w-4 h-4" />
            </button>
            <button
              title={t("mailDetail.deleteConversation")}
              aria-label={t("mailDetail.deleteConversation")}
              onClick={handleTrash}
              className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
            >
              <TrashIcon size={16} strokeWidth={1.5} dangerHover />
            </button>
            <div className="w-px h-4 bg-border mx-0.5" />
            <AiSummaryButton mailId={mail.id} threadMode={!isSingleMail} onToggle={() => setShowAiSummary((v) => !v)} active={showAiSummary} />
            <AiReplyButton mailId={latestMail.id} onToggle={() => setShowAiReplies((v) => !v)} active={showAiReplies} />
            {mail.list_unsubscribe && (
              <button
                title={t("unsubscribe.title")}
                aria-label={t("unsubscribe.title")}
                onClick={handleUnsubscribe}
                className="p-1.5 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
              >
                <MailMinus className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-6 h-6 text-accent animate-spin" />
          </div>
        ) : (
          <ThreadMessages
            threadMails={threadMails}
            isSingleMail={isSingleMail}
            loading={loading}
            selectedMailId={mail.id}
            onReply={handleReply}
            onReplyAll={handleReplyAll}
            onForward={handleForward}
            onLinkClick={handleLinkClick}
            onUpdateMail={handleUpdateThreadMail}
          />
        )}
      </div>
    </div>
  );
}
