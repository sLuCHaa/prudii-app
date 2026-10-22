import { useEffect, useState, useRef, useCallback, memo, useMemo } from "react";
import { Tooltip } from "../ui/Tooltip";
import { parseISO } from "date-fns";
import { FileText, Image, Film, Music, File, Loader2, Download, ChevronDown, ChevronRight, ChevronUp, MessageSquare, Copy, Check, Code, Eye, FileCode, FileType, Printer, MailMinus, ImageOff, FileWarning, FolderOpen, ClipboardList, ClipboardPlus, Ellipsis } from "lucide-react";
import { SkeletonText } from "../ui/Skeleton";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { openUrl } from "@tauri-apps/plugin-opener";
import { convertFileSrc } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../../stores/appStore";
import { ReadingAmbient } from "./ReadingAmbient";
import { resolveInlineImages, removeUnresolvableImages, listedAttachments } from "../../lib/inlineImages";
import { findMissingParts, stripMmlTags } from "../../lib/missingParts";
import { invalidateMailListQueries } from "../../lib/mailQueries";
import { useAttachments, useToggleStar, useToggleMailFlag } from "../../hooks/useAccounts";
import { useScroller } from "../../hooks/useScroller";
import { useChatAnchor } from "../../hooks/useChatAnchor";
import { splitEmbeddedMails } from "../../lib/embeddedMails";
import { embeddedMailToMail, resolveNameOnlySender } from "../../lib/embeddedReply";
import { EmbeddedMailCards } from "./EmbeddedMailCards";
import { stripQuotedHtml, stripQuotedText, isForwardSubject } from "../../lib/quotedHistory";
import { makeIsOutgoing } from "../../lib/outgoing";
import { recipientSummary } from "../../lib/recipientSummary";
import { searchContacts, openAttachment, startAttachmentDrag, quickLookAttachment, saveAttachment, fetchMailBody, trashMail, archiveMail, getThreadMails, markAsRead, unsubscribeMail } from "../../lib/tauri";
import { revealLabelKey, revealAttachment } from "../../lib/attachmentActions";
import { isMacOS, isWindows } from "../../lib/platform";
import { MAIL_LINK_BRIDGE, MAIL_LINK_BRIDGE_CSP_HASH, relayBridgeKey, parseBridgeContextMenu, type BridgeContextMenu } from "../../lib/mailLinkBridge";
import { MailBodyContextMenu } from "./MailBodyContextMenu";
import { detectCause, causeMessage } from "../../lib/errorToast";
import { openMailUrl } from "../../lib/trackingParams";
import { ContactAvatar } from "../ui/ContactAvatar";
import { FlagPicker } from "../ui/FlagPicker";
import type { MailFlag } from "../../types";
import { Archive, Attach as Paperclip, Forward, Reply, ReplyAll, StarIcon, TrashIcon } from "../icons";
import { formatDateTime, formatMailDate } from "../../lib/dateUtils";
import { sanitizeEmailHtml, escapeHtml, type TrackerInfo } from "../../lib/sanitize";
import { decodeFileUrl } from "../../lib/outgoingHtml";
import { TrackingIndicator } from "./TrackingIndicator";
import { MailSourceView } from "./MailSourceView";
import { AiSummaryButton, AiSummaryPanel } from "../ai/AiSummary";
import { AiReplyButton, AiReplySuggestionsPanel } from "../ai/AiReplySuggestions";
import { useDialog } from "../ui/DialogProvider";
import { ContextMenu } from "../ui/ContextMenu";
import type { MenuEntry } from "../../lib/menuModel";
import { useMailTasks, useLinkMailToTask } from "../../hooks/useTasks";
import { LinkedTaskChip } from "../tasks/MailTaskChip";
import { TaskPickerDialog } from "../tasks/TaskPickerDialog";
import { CreateTaskFromMail } from "../tasks/CreateTaskFromMail";
import { InvitationCard } from "../calendar/InvitationCard";
import type { Mail, Attachment, MailAddress } from "../../types";
import { useTranslation } from "react-i18next";
import { ImageLightbox, type ImageLightboxItem } from "./ImageLightbox";
import { formatFileSize } from "../../lib/fileSize";
import { useMailFrameFit } from "../../hooks/useMailFrameFit";
import { useOpenCheckedLink } from "../../hooks/useOpenCheckedLink";

function getFileIcon(mimeType: string | null) {
  if (!mimeType) return File;
  if (mimeType.startsWith("image/")) return Image;
  if (mimeType.startsWith("video/")) return Film;
  if (mimeType.startsWith("audio/")) return Music;
  if (mimeType.includes("pdf") || mimeType.includes("document") || mimeType.includes("text")) return FileText;
  return File;
}

function formatRecipient(a: MailAddress): string {
  return a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email;
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
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-hover transition-colors group text-xs"
      draggable={!!attachment.local_path}
      onDragStart={(e) => {
        // HTML5 drag cannot hand a file to the OS; the native session takes over.
        e.preventDefault();
        startAttachmentDrag(attachment.id).catch((err) => {
          addToast("error", t("errors.attachmentOpen"), err instanceof Error ? err.message : String(err));
        });
      }}
      tabIndex={0}
      role="button"
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== " " && e.key !== "Enter")) return;
        e.preventDefault();
        if (isMacOS) quickLookAttachment(attachment.id).catch(() => handleOpen());
        else handleOpen();
      }}
    >
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
      {attachment.local_path && (
        <Tooltip label={t(revealLabelKey({ isMac: isMacOS, isWindows }))}>
          <button
            onClick={(e) => { e.stopPropagation(); revealAttachment(attachment.id).catch(() => {}); }}
            className="p-1 rounded hover:bg-hover transition-colors opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text"
            aria-label={t(revealLabelKey({ isMac: isMacOS, isWindows }))}
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      )}
    </div>
  );
});

const AttachmentList = memo(function AttachmentList({ mailId, bodyHtml, className = "mt-3 pt-3 border-t border-border-light" }: { mailId: string; bodyHtml: string; className?: string }) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const { data: attachments } = useAttachments(mailId);

  const visible = useMemo(() => listedAttachments(bodyHtml, attachments ?? []), [attachments, bodyHtml]);
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
    <div className={className}>
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
  ::-webkit-scrollbar-thumb { background: #D4D4D8; }
  ::-webkit-scrollbar-thumb:hover { background: #A1A1AA; }
`;

const DARK_STYLES = `
  html { background: transparent; color-scheme: dark; }
  body {
    color: #1a1a1a;
    filter: invert(0.88) hue-rotate(180deg);
    /* The filter inverts a light rendering, so system colors like Outlook's windowtext must resolve light. */
    color-scheme: light;
    /* A mail's body background is painted on the canvas, out of the filter's reach. */
    background: transparent !important;
  }
  a { color: #2563eb; }
  img, video, picture, svg {
    filter: invert(1) hue-rotate(180deg) !important;
  }
  hr { opacity: 0.4; }
  blockquote { border-left-color: #888 !important; }
  ::-webkit-scrollbar-thumb { background: #3F3F46; }
  ::-webkit-scrollbar-thumb:hover { background: #52525B; }
`;

const HtmlMailFrame = memo(function HtmlMailFrame({ mailId, html, tight = false, allowExternalImages = true, onIframeRef, onTrackersDetected, onLinkClick, onImageClick }: { mailId: string; html: string; tight?: boolean; allowExternalImages?: boolean; onIframeRef?: (el: HTMLIFrameElement | null) => void; onTrackersDetected?: (trackers: TrackerInfo[]) => void; onLinkClick?: (href: string) => void; onImageClick?: (src: string) => void }) {
  const darkMode = useAppStore((s) => s.darkMode);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const { height, refit } = useMailFrameFit(iframeRef);
  const [bodyMenu, setBodyMenu] = useState<{ target: BridgeContextMenu; x: number; y: number; seq: number } | null>(null);
  const { t } = useTranslation();

  const themeStyles = darkMode ? DARK_STYLES : LIGHT_STYLES;

  const { data: attachments } = useAttachments(mailId);
  const { html: cleanHtml, trackers } = useMemo(() => {
    const res = sanitizeEmailHtml(html, allowExternalImages);
    if (!/file:\/\/|cid:|blob:|Attachment\//.test(res.html)) return res;
    const d = document.createElement("div");
    d.innerHTML = res.html;
    // Fetch-time rewriting only knows plain cid: references; the rest resolves
    // here. Unresolved images are dropped only once the attachments are known.
    resolveInlineImages(d, attachments ?? []);
    if (attachments) removeUnresolvableImages(d);
    // Locally stored inline images are referenced as file:// by the backend;
    // only convertFileSrc knows the platform's asset origin.
    d.querySelectorAll('img[src^="file://"]').forEach((img) => {
      img.setAttribute("src", convertFileSrc(decodeFileUrl(img.getAttribute("src") ?? "")));
    });
    return { html: d.innerHTML, trackers: res.trackers };
  }, [html, allowExternalImages, attachments]);

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
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="script-src '${MAIL_LINK_BRIDGE_CSP_HASH}'; object-src 'none';"><style>
${BASE_STYLES}${tight ? "\n  body { padding: 4px 0; }" : ""}
</style></head><body>${cleanHtml}<style>${themeStyles}</style><script>${MAIL_LINK_BRIDGE}</script></body></html>`,
    [cleanHtml, themeStyles, tight]
  );

  useEffect(() => {
    refit();
  }, [html, darkMode, refit]);

  const openHref = useCallback(
    (rawHref: string) => {
      let href = rawHref;
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
    },
    [onLinkClick]
  );

  // The in-frame LINK_BRIDGE relays clicks here via postMessage (a parent-side
  // listener on the iframe's contentDocument never fires on macOS/WKWebView).
  useEffect(() => {
    function handleMessage(e: MessageEvent) {
      const iframe = iframeRef.current;
      if (!iframe || e.source !== iframe.contentWindow) return;
      if (relayBridgeKey(e.data)) return;

      const ctx = parseBridgeContextMenu(e.data);
      if (ctx) {
        const r = iframe.getBoundingClientRect();
        // seq forces a remount: a second right-click while the menu is already
        // open must reset MenuPanel's stale focused/previous state, not reconcile.
        setBodyMenu((prev) => ({ target: ctx, x: r.left + ctx.x, y: r.top + ctx.y, seq: (prev?.seq ?? 0) + 1 }));
        return;
      }

      const data = e.data as { __prudiiLink?: string; __prudiiImage?: string } | null;
      if (!data) return;

      if (typeof data.__prudiiImage === "string") {
        onImageClick?.(data.__prudiiImage);
        return;
      }

      const href = data.__prudiiLink?.trim();
      if (!href || href.startsWith("#")) return;
      openHref(href);
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, [onImageClick, openHref]);

  useEffect(() => {
    if (onIframeRef) onIframeRef(iframeRef.current);
  }, [onIframeRef]);

  return (
    <>
      <iframe
        ref={iframeRef}
        srcDoc={srcDoc}
        sandbox="allow-same-origin allow-scripts"
        // On a color-scheme mismatch Chromium paints an opaque canvas behind the mail.
        style={{ width: "100%", height, border: "none", overflow: "hidden", background: "transparent", colorScheme: darkMode ? "dark" : "light" }}
        onLoad={refit}
        aria-label={t("mailDetail.emailContent")}
      />
      {bodyMenu && (
        <MailBodyContextMenu
          key={bodyMenu.seq}
          target={bodyMenu.target}
          x={bodyMenu.x}
          y={bodyMenu.y}
          onClose={() => setBodyMenu(null)}
          onOpenLink={openHref}
          onOpenImage={onImageClick}
        />
      )}
    </>
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
  singleMail?: boolean;
  defaultExpanded: boolean;
  chat?: boolean;
  own?: boolean;
  onCollapse?: (mailId: string) => void;
  onReply: (mail: Mail) => void;
  onReplyAll: (mail: Mail) => void;
  onForward: (mail: Mail) => void;
  onIframeRef?: (el: HTMLIFrameElement | null) => void;
  onLinkClick?: (href: string) => void;
  onUpdateMail?: (mailId: string, updates: Partial<Mail>) => void;
}

const MessageCard = memo(function MessageCard({ mail, isLatest, singleMail, defaultExpanded, chat, own, onCollapse, onReply, onReplyAll, onForward, onIframeRef, onLinkClick, onUpdateMail }: MessageCardProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showQuoted, setShowQuoted] = useState(false);
  const [showDetails, setShowDetails] = useState(false);
  const [loadedMail, setLoadedMail] = useState<Mail | null>(null);
  const [loading, setLoading] = useState(false);
  const setMails = useAppStore((s) => s.setMails);
  const appSettings = useAppStore((s) => s.appSettings);
  const accounts = useAppStore((s) => s.accounts);
  const folders = useAppStore((s) => s.folders);
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

  const handleToggle = useCallback(() => {
    if (expanded) onCollapse?.(mail.id);
    setExpanded(!expanded);
  }, [expanded, onCollapse, mail.id]);
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
  // Separate from viewPlainText and taking precedence: the source is a third
  // view, not a variant of the body, and it exists even for mails that have
  // only a text part.
  const [viewSource, setViewSource] = useState(false);
  const [trackers, setTrackers] = useState<TrackerInfo[]>([]);
  const [cardsOff, setCardsOff] = useState(false);
  const [allowImagesOverride, setAllowImagesOverride] = useState(false);
  const hasBody = displayMail.body_html || displayMail.body_text;
  const hasBothFormats = !!displayMail.body_html && !!displayMail.body_text;
  const showsHtml = !!displayMail.body_html && !viewPlainText;
  const plainText = useMemo(() => stripMmlTags(displayMail.body_text ?? ""), [displayMail.body_text]);

  const collapsesQuotes = !!chat && !isForwardSubject(mail.subject);
  const htmlWithoutQuotes = useMemo(
    () => (collapsesQuotes && displayMail.body_html ? stripQuotedHtml(displayMail.body_html) : null),
    [collapsesQuotes, displayMail.body_html],
  );
  const textWithoutQuotes = useMemo(
    () => (collapsesQuotes && plainText ? stripQuotedText(plainText) : null),
    [collapsesQuotes, plainText],
  );
  const hasQuotes = !viewSource && (showsHtml ? htmlWithoutQuotes : textWithoutQuotes) !== null;
  const hideQuotes = hasQuotes && !showQuoted;
  const quotesHidden = hideQuotes && !!htmlWithoutQuotes;

  const embedded = useMemo(
    () => (expanded && showsHtml && !viewSource && !quotesHidden ? splitEmbeddedMails(displayMail.body_html) : null),
    [expanded, showsHtml, viewSource, quotesHidden, displayMail.body_html],
  );
  const split = cardsOff ? null : embedded;

  const accountAllowsImages = useMemo(() => {
    const acct = accounts.find((a) => a.id === mail.account_id);
    return acct?.load_external_images !== "never";
  }, [accounts, mail.account_id]);

  const allowExternalImages = allowImagesOverride || accountAllowsImages;

  // Reset per-message image override when navigating to a different mail
  useEffect(() => {
    setAllowImagesOverride(false);
    setCardsOff(false);
  }, [mail.id]);

  const incrementTrackersBlocked = useAppStore((s) => s.incrementTrackersBlocked);

  // The frame re-detects on every HTML change; the tally counts each message once.
  const trackersCountedRef = useRef(false);
  const handleTrackersDetected = useCallback((detected: TrackerInfo[]) => {
    setTrackers((prev) => {
      const fresh = detected.filter((d) => !prev.some((p) => p.type === d.type && p.src === d.src));
      return fresh.length > 0 ? [...prev, ...fresh] : prev;
    });
    if (detected.length > 0 && !trackersCountedRef.current) {
      trackersCountedRef.current = true;
      incrementTrackersBlocked(detected.length);
    }
  }, [incrementTrackersBlocked]);

  const cardTrackers = useMemo(
    () => (split ? sanitizeEmailHtml(displayMail.body_html, allowExternalImages).trackers : null),
    [!!split, displayMail.body_html, allowExternalImages],
  );
  useEffect(() => {
    if (cardTrackers) handleTrackersDetected(cardTrackers);
  }, [cardTrackers, handleTrackersDetected]);

  const hasExternalImages = useMemo(() => {
    if (!displayMail.body_html) return false;
    return /<img[^>]+src=["']https?:\/\//i.test(displayMail.body_html);
  }, [displayMail.body_html]);

  // Waiting for the attachment list matters: until it arrives every cid looks
  // unresolvable and the banner would flash on perfectly fine mails.
  const { data: messageAttachments } = useAttachments(displayMail.id);
  const missingParts = useMemo(
    () => (messageAttachments ? findMissingParts(displayMail, messageAttachments) : { names: [], count: 0 }),
    [displayMail.body_html, displayMail.body_text, messageAttachments]
  );

  const formattedDate = useMemo(() =>
    formatDateTime(parseISO(mail.date), appSettings.use_24h_clock)
  , [mail.date, appSettings.use_24h_clock]);

  const recipients = useMemo(() =>
    mail.to.map(formatRecipient).join(", ")
  , [mail.to]);

  const ccRecipients = useMemo(() =>
    mail.cc.length > 0 ? mail.cc.map(formatRecipient).join(", ") : null
  , [mail.cc]);

  const isDraft = useMemo(
    () => folders.find((f) => f.id === mail.folder_id)?.folder_type === "drafts",
    [folders, mail.folder_id],
  );

  const fromLine = (
    <div className="flex items-center gap-1.5 mb-0.5">
      <span className="text-text-secondary font-medium select-text">{mail.from.name || mail.from.email}</span>
      <span className="select-text">&lt;{mail.from.email}&gt;</span>
      <CopyEmailButton email={mail.from.email} />
    </div>
  );

  const senderLines = (
    <>
      {fromLine}
      {/* Empfaenger aufklappbar: zugeklappt eine Zeile, aufgeklappt
          bricht dieselbe Zeile um und Cc kommt dazu — nichts wird
          doppelt gezeigt und nichts dauerhaft versteckt. */}
      <details className="group">
        <summary className="flex items-start gap-1 cursor-pointer list-none [&::-webkit-details-marker]:hidden hover:text-text-secondary">
          <ChevronRight className="w-3 h-3 mt-0.5 shrink-0 transition-transform group-open:rotate-90" />
          <span className="truncate group-open:whitespace-normal select-text">
            {t("mailDetail.toLabel")}: {recipients}
          </span>
        </summary>
        {ccRecipients && (
          <div className="ml-4 mt-0.5 select-text">
            {t("mailDetail.ccLabel")}: {ccRecipients}
          </div>
        )}
      </details>
    </>
  );

  const viewToggleClass = (active: boolean) =>
    `flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors ${
      active ? "bg-accent-soft text-accent" : "text-text-tertiary hover:text-text-secondary hover:bg-hover"
    }`;

  const viewToggles = (
    <>
      {hasBothFormats && (
        <>
          <button onClick={() => setViewPlainText(false)} className={viewToggleClass(!viewPlainText)}>
            <Code className="w-3.5 h-3.5" />
            {t("mailDetail.htmlView")}
          </button>
          <button onClick={() => setViewPlainText(true)} className={viewToggleClass(viewPlainText)}>
            <FileType className="w-3.5 h-3.5" />
            {t("mailDetail.plainText")}
          </button>
        </>
      )}
      <button onClick={() => setViewSource((v) => !v)} className={viewToggleClass(viewSource)}>
        <FileCode className="w-3.5 h-3.5" />
        {t("mailDetail.sourceView")}
      </button>
    </>
  );

  // Attachments live ABOVE the body: a forwarded conversation can carry pages
  // of quoted history, and the files were buried below all of it. Shown when
  // the flag is set OR the body is loaded (header-sync flags can be inaccurate).
  const showAttachments = !!(displayMail.has_attachments || displayMail.body_html || displayMail.body_text);

  const bodyFallback = loading ? (
    // Content-shaped placeholder instead of a lone spinner — the ~64px
    // spinner box caused a hard layout jump when the body arrived.
    <div className="py-4 space-y-3">
      <SkeletonText lines={3} />
      <div className="h-2" />
      <SkeletonText lines={4} />
      <div className="h-2" />
      <SkeletonText lines={2} />
    </div>
  ) : bodyError ? (
    <div className="py-4 text-center">
      <p className="text-sm text-danger">{t("errors.bodyLoad")}</p>
      {detectCause(bodyError) && (
        <p className="text-xs text-text-tertiary mt-1">{t(`errors.cause.${detectCause(bodyError)}`)}</p>
      )}
    </div>
  ) : !hasBody ? (
    <p className="py-4 text-sm text-text-tertiary text-center">{t("mailDetail.noContent")}</p>
  ) : null;

  const notices = (
    <>
      <InvitationCard mailId={displayMail.id} enabled={!!hasBody} />
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
      {missingParts.count > 0 && (
        <div className="flex items-start gap-2 px-4 py-2 mb-2 bg-bg-secondary border border-border rounded-lg text-xs text-text-secondary">
          <FileWarning className="w-3.5 h-3.5 mt-px text-text-tertiary shrink-0" />
          <span>
            {missingParts.names.length === missingParts.count
              ? t("mailDetail.missingParts.named", { count: missingParts.count, names: missingParts.names.join(", ") })
              : t("mailDetail.missingParts.message", { count: missingParts.count })}
          </span>
        </div>
      )}
    </>
  );

  const frame = (html: string, ref?: (el: HTMLIFrameElement | null) => void) => (
    <HtmlMailFrame mailId={displayMail.id} html={html} tight={!!chat} allowExternalImages={allowExternalImages} onIframeRef={ref} onTrackersDetected={split ? undefined : handleTrackersDetected} onLinkClick={onLinkClick} onImageClick={handleInlineImageClick} />
  );
  const mainFrameRef = (el: HTMLIFrameElement | null) => { messageIframeRef.current = el; onIframeRef?.(el); };

  const handleCardReply = async (index: number) => {
    if (!split) return;
    const target = embeddedMailToMail(displayMail, split.parts[index]);
    const resolved = await resolveNameOnlySender(target, (q) => searchContacts(q, displayMail.account_id)).catch(() => target);
    onReply(resolved);
  };
  const handleCardForward = (index: number) => {
    if (split) onForward(embeddedMailToMail(displayMail, split.parts[index]));
  };

  const body = viewSource ? (
    <MailSourceView mailId={displayMail.id} />
  ) : split ? (
    <>
      {split.outer && frame(split.outer, mainFrameRef)}
      <EmbeddedMailCards
        key={`${displayMail.id}:${split.parts.length}`}
        parts={split.parts}
        renderBody={(html) => frame(html)}
        onReply={handleCardReply}
        onForward={handleCardForward}
        onShowWithout={() => setCardsOff(true)}
      />
    </>
  ) : showsHtml ? (
    <>
      {cardsOff && embedded && (
        <button type="button" onClick={() => setCardsOff(false)} className="mb-1 px-2 py-1 rounded text-xs font-medium text-text-tertiary hover:text-text-secondary hover:bg-hover transition-colors">
          {t("mailDetail.embedded.showCards")}
        </button>
      )}
      {frame((hideQuotes && htmlWithoutQuotes) || displayMail.body_html || "", mainFrameRef)}
    </>
  ) : (
    <pre className="text-sm text-text-secondary whitespace-pre-wrap font-sans leading-relaxed select-text">
      {hideQuotes && textWithoutQuotes !== null ? textWithoutQuotes : plainText}
    </pre>
  );

  const lightbox = inlineLightbox && (
    <ImageLightbox
      images={[inlineLightbox]}
      initialIndex={0}
      onClose={() => setInlineLightbox(null)}
      onDownload={() => { /* not reachable: canDownload === false */ }}
    />
  );

  const starButton = (
    <button
      onClick={handleStar}
      className={`p-1.5 rounded-control hover:bg-hover transition-colors ${
        mail.is_starred ? "text-warning" : "text-text-tertiary"
      }`}
    >
      <StarIcon size={14} strokeWidth={1.5} color={mail.is_starred ? "var(--c-warning)" : "currentColor"} />
    </button>
  );

  if (chat) {
    const name = own ? t("mailDetail.you") : mail.from.name || mail.from.email;
    const shape = own
      ? "bg-surface border-border border-t-[3px] border-t-accent rounded-xl shadow-sm"
      : "border-border rounded-[14px] rounded-tl-[4px]";
    const divider = "border-border-light";
    const summary = own ? recipientSummary(mail.to, mail.cc) : null;
    const recipientList = (
      <div className="flex flex-col gap-1">
        {[{ label: t("mailDetail.toLabel"), list: mail.to }, { label: t("mailDetail.ccLabel"), list: mail.cc }]
          .filter((g) => g.list.length > 0)
          .map((g) => (
            <div key={g.label}>
              <div className="opacity-70">{g.label}</div>
              {g.list.map((a, i) => <div key={i}>{formatRecipient(a)}</div>)}
            </div>
          ))}
      </div>
    );
    const action = "flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover transition-colors";

    return (
      <div className={`flex items-start gap-2.5 min-w-0 ${expanded ? "w-[min(85%,780px)]" : "max-w-[min(85%,780px)]"}`}>
        {!own && <ContactAvatar name={mail.from.name} email={mail.from.email} size={28} className="shrink-0 mt-5.5" />}
        <div className={`flex-1 min-w-0 flex flex-col gap-1 ${own ? "items-end" : "items-start"}`}>
          <div className="flex items-center gap-1.5 max-w-full px-1 text-xs text-text-tertiary">
            <button
              type="button"
              onClick={handleToggle}
              aria-expanded={expanded}
              className="flex items-center gap-1.5 min-w-0 rounded hover:text-text-secondary transition-colors"
            >
              {!mail.is_read && <span className="w-2 h-2 rounded-full bg-accent shrink-0" />}
              <span className="font-medium text-text-secondary truncate">{name}</span>
              {isDraft && (
                <span className="px-1.5 py-0.5 text-[11px] font-medium bg-warning/15 text-warning rounded-sm shrink-0">
                  {t("mailDetail.draft")}
                </span>
              )}
              {own && summary && (
                <>
                  <span aria-hidden="true">→</span>
                  <span className="truncate">{summary.first}</span>
                </>
              )}
            </button>
            {own && summary && summary.more > 0 && (
              <Tooltip rich side="top" label={recipientList}>
                <button
                  type="button"
                  aria-label={`${t("mailDetail.showAllRecipients")}: ${[...mail.to, ...mail.cc].map(formatRecipient).join(", ")}`}
                  className="px-1.5 rounded-full bg-bg-tertiary text-[11px] font-medium text-text-secondary hover:bg-hover transition-colors"
                >
                  +{summary.more}
                </button>
              </Tooltip>
            )}
            <span aria-hidden="true">·</span>
            <span className="shrink-0">{formattedDate}</span>
          </div>

          {expanded ? (
            <div className={`w-full min-w-0 border px-3.5 pt-3 pb-1.5 ${shape} ${isDraft ? "ring-2 ring-warning/40" : ""}`}>
              {showAttachments && <AttachmentList mailId={displayMail.id} bodyHtml={displayMail.body_html} className="mb-2.5" />}
              {bodyFallback ?? <div className="prose-sm">{notices}{body}</div>}

              {hasQuotes && (
                <button
                  type="button"
                  onClick={() => {
                    if (showQuoted) onCollapse?.(mail.id);
                    setShowQuoted(!showQuoted);
                  }}
                  aria-expanded={showQuoted}
                  className="mt-2 inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-sm border border-border text-xs font-medium text-text-tertiary hover:bg-hover hover:text-text-secondary transition-colors"
                >
                  <Ellipsis className="w-3.5 h-3.5" />
                  {showQuoted ? t("mailDetail.hideQuoted") : t("mailDetail.showQuoted")}
                </button>
              )}

              {showDetails && (
                <div className={`mt-2.5 pt-2.5 border-t text-xs text-text-tertiary ${divider}`}>
                  {fromLine}
                  <div className="select-text">{t("mailDetail.toLabel")}: {recipients}</div>
                  {ccRecipients && (
                    <div className="mt-0.5 select-text">{t("mailDetail.ccLabel")}: {ccRecipients}</div>
                  )}
                  {!bodyFallback && (
                    <div className="flex flex-wrap items-center gap-1 mt-2">
                      {viewToggles}
                      <button onClick={handlePrint} className={viewToggleClass(false)}>
                        <Printer className="w-3.5 h-3.5" />
                        {t("mailDetail.print")}
                      </button>
                      {trackers.length === 0 && <TrackingIndicator trackers={trackers} />}
                    </div>
                  )}
                </div>
              )}

              {lightbox}

              <div className={`mt-2.5 pt-1 border-t flex flex-wrap items-center gap-0.5 ${divider}`}>
                <button onClick={handleReply} className={action}>
                  <Reply className="w-4 h-4" />
                  {t("mailDetail.reply")}
                </button>
                <button onClick={handleReplyAll} className={action}>
                  <ReplyAll className="w-4 h-4" />
                  {t("mailDetail.replyAll")}
                </button>
                <button onClick={handleForward} className={action}>
                  <Forward className="w-4 h-4" />
                  {t("mailDetail.forward")}
                </button>
                <div className="flex-1" />
                {trackers.length > 0 && <TrackingIndicator trackers={trackers} />}
                <button
                  onClick={() => setShowDetails((v) => !v)}
                  aria-expanded={showDetails}
                  className={`${action} ${showDetails ? "text-accent" : ""}`}
                >
                  {t("mailDetail.details")}
                </button>
                <FlagPicker flags={mail.flags || []} onToggleFlag={handleToggleFlag} size="sm" />
                {starButton}
                <Tooltip label={t("mailDetail.collapseMessage")}>
                  <button
                    onClick={handleToggle}
                    aria-label={t("mailDetail.collapseMessage")}
                    className="p-1.5 rounded-control hover:bg-hover transition-colors text-text-tertiary"
                  >
                    <ChevronUp className="w-4 h-4" />
                  </button>
                </Tooltip>
              </div>
            </div>
          ) : (
            <button
              type="button"
              onClick={handleToggle}
              aria-label={t("mailDetail.expandMessage", { name })}
              className={`flex items-center gap-2 max-w-full min-w-0 border px-3 py-2 text-left text-text-tertiary hover:border-text-tertiary transition-colors ${shape}`}
            >
              {mail.has_attachments && <Paperclip className="w-3.5 h-3.5 shrink-0" />}
              <span className="truncate text-[13px] text-text-secondary">{mail.snippet || mail.subject}</span>
              <ChevronDown className="w-3.5 h-3.5 shrink-0" />
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-surface border border-border rounded-xl overflow-hidden transition-shadow shadow-card-soft inset-shadow-edge ${
      isDraft ? "ring-2 ring-warning/40" : !singleMail && isLatest ? "ring-2 ring-accent/30" : ""
    }`}>
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
            <span className="font-medium text-text text-sm truncate select-text">
              {mail.from.name || mail.from.email}
            </span>
            {isDraft && (
              <span className="px-1.5 py-0.5 text-[11px] font-medium bg-warning/15 text-warning rounded-sm shrink-0">
                {t("mailDetail.draft")}
              </span>
            )}
            {!singleMail && isLatest && !isDraft && (
              <span className="px-1.5 py-0.5 text-[11px] font-medium bg-accent/10 text-accent rounded-sm">
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
          <div className="text-xs text-text-tertiary truncate select-text">
            {formattedDate}
            {!expanded && mail.snippet && (
              <span className="ml-2 text-text-secondary">— {mail.snippet}</span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0" onClick={(e) => e.stopPropagation()}>
          <FlagPicker flags={mail.flags || []} onToggleFlag={handleToggleFlag} size="sm" />
          {starButton}
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
          <div className="py-2 text-xs text-text-tertiary">{senderLines}</div>

          {showAttachments && (
            <AttachmentList mailId={displayMail.id} bodyHtml={displayMail.body_html} className="mb-3 pb-3 border-b border-border-light" />
          )}

          {bodyFallback ?? (
            <div className="prose-sm">
              <div className="flex items-center gap-1 mb-2">
                {viewToggles}
                <div className="flex-1" />
                <TrackingIndicator trackers={trackers} />
              </div>
              {notices}
              {body}
            </div>
          )}

          {lightbox}

          <div className="mt-3 pt-3 border-t border-border-light flex items-center gap-2">
            <button
              onClick={handleReply}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover transition-colors"
            >
              <Reply className="w-4 h-4" />
              {t("mailDetail.reply")}
            </button>
            <button
              onClick={handleReplyAll}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover transition-colors"
            >
              <ReplyAll className="w-4 h-4" />
              {t("mailDetail.replyAll")}
            </button>
            <button
              onClick={handleForward}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover transition-colors"
            >
              <Forward className="w-4 h-4" />
              {t("mailDetail.forward")}
            </button>
            <button
              onClick={handlePrint}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover transition-colors"
            >
              <Printer className="w-4 h-4" />
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
  senderLabel: string;
  onLocate: () => void;
}

const ThreadAttachmentItem = memo(function ThreadAttachmentItem({ attachment, senderLabel, onLocate }: ThreadAttachmentItemProps) {
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
    <div
      className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-hover transition-colors group text-xs"
      draggable={!!attachment.local_path}
      onDragStart={(e) => {
        // HTML5 drag cannot hand a file to the OS; the native session takes over.
        e.preventDefault();
        startAttachmentDrag(attachment.id).catch((err) => {
          addToast("error", t("errors.attachmentOpen"), err instanceof Error ? err.message : String(err));
        });
      }}
      tabIndex={0}
      role="button"
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || (e.key !== " " && e.key !== "Enter")) return;
        e.preventDefault();
        if (isMacOS) quickLookAttachment(attachment.id).catch(() => handleOpen());
        else handleOpen();
      }}
    >
      <div className="min-w-0 flex-1">
        <button
          onClick={handleOpen}
          className="flex items-center gap-2 text-left min-w-0 w-full"
        >
          <Icon className="w-4 h-4 text-text-tertiary shrink-0" />
          <span className="text-text truncate flex-1">{attachment.filename}</span>
        </button>
        {/* Own click target (buttons must not nest): jumps to the message the
            attachment belongs to, so the label answers "from which mail?" */}
        <button
          onClick={onLocate}
          title={t("mailDetail.goToMessage")}
          className="block pl-6 max-w-full truncate text-left text-text-tertiary text-[11px] hover:text-accent transition-colors"
        >
          {senderLabel}
          {attachment.size_bytes ? ` · ${formatFileSize(attachment.size_bytes)}` : ""}
        </button>
      </div>
      <button
        onClick={handleSave}
        disabled={saving}
        className="p-1 rounded hover:bg-hover transition-colors opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text disabled:opacity-50"
        aria-label={t("mailDetail.saveAttachment")}
      >
        {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Download className="w-3.5 h-3.5" />}
      </button>
      {attachment.local_path && (
        <Tooltip label={t(revealLabelKey({ isMac: isMacOS, isWindows }))}>
          <button
            onClick={(e) => { e.stopPropagation(); revealAttachment(attachment.id).catch(() => {}); }}
            className="p-1 rounded hover:bg-hover transition-colors opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text"
            aria-label={t(revealLabelKey({ isMac: isMacOS, isWindows }))}
          >
            <FolderOpen className="w-3.5 h-3.5" />
          </button>
        </Tooltip>
      )}
    </div>
  );
});

interface ThreadAttachmentsProps {
  threadMails: Mail[];
  loading: boolean;
  onLocate: (mailId: string) => void;
}

const ThreadAttachments = memo(function ThreadAttachments({ threadMails, loading, onLocate }: ThreadAttachmentsProps) {
  const { t } = useTranslation();
  // Collapsed by default: the strip only renders for conversations whose
  // attachments are spread over several messages, and even then the header
  // space matters more than the overview. "0" is the explicit opt-in written
  // by toggleExpanded, so anyone who opened it before keeps it open.
  const [expanded, setExpanded] = useState(() => {
    try {
      return localStorage.getItem("thread-attachments-collapsed") === "0";
    } catch {
      return false;
    }
  });
  const toggleExpanded = () => {
    setExpanded((prev) => {
      const next = !prev;
      try {
        localStorage.setItem("thread-attachments-collapsed", next ? "0" : "1");
      } catch { /* per-viewer convenience only */ }
      return next;
    });
  };

  const mailsWithAttachments = useMemo(
    () => threadMails.filter((m) => m.has_attachments),
    [threadMails]
  );

  const totalCount = mailsWithAttachments.length;
  // Unter zwei Nachrichten ist die Leiste eine woertliche Wiederholung der
  // Anhangsliste in der Nachricht darunter — und kostet oben ~120px, die auf
  // einem 13-Zoll-Display fehlen.
  if (totalCount < 2) return null;

  const pendingBodies = mailsWithAttachments.filter(
    (m) => !m.body_html && !m.body_text
  ).length;
  const allBodiesLoaded = pendingBodies === 0 && !loading;

  return (
    <div className="border-b border-border bg-surface">
      <button
        onClick={toggleExpanded}
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
          onLocate={onLocate}
        />
      )}
    </div>
  );
});

interface ThreadAttachmentsContentProps {
  mailsWithAttachments: Mail[];
  allBodiesLoaded: boolean;
  onLocate: (mailId: string) => void;
}

const ThreadAttachmentsContent = memo(function ThreadAttachmentsContent({
  mailsWithAttachments,
  allBodiesLoaded,
  onLocate,
}: ThreadAttachmentsContentProps) {
  const { t } = useTranslation();
  const mailsReady = mailsWithAttachments.filter((m) => m.body_html || m.body_text);

  return (
    <div className="px-6 pb-3">
      {mailsReady.map((m) => (
        <MailAttachmentGroup key={m.id} mail={m} onLocate={onLocate} />
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

const MailAttachmentGroup = memo(function MailAttachmentGroup({ mail, onLocate }: { mail: Mail; onLocate: (mailId: string) => void }) {
  const { data: attachments } = useAttachments(mail.id);
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const visible = useMemo(() => listedAttachments(mail.body_html, attachments ?? []), [attachments, mail.body_html]);
  const senderName = mail.from.name || mail.from.email;
  // Date included: with two mails from the same sender the name alone
  // doesn't say which message an attachment belongs to.
  const senderLabel = `${senderName} · ${formatMailDate(mail.date, use24h)}`;
  const locate = useCallback(() => onLocate(mail.id), [onLocate, mail.id]);

  if (visible.length === 0) return null;

  return (
    <div className="flex flex-wrap gap-1.5 mt-1.5">
      {visible.map((att) => (
        <ThreadAttachmentItem key={att.id} attachment={att} senderLabel={senderLabel} onLocate={locate} />
      ))}
    </div>
  );
});

// Older bubbles start collapsed: every expanded one fetches its body.
const CHAT_EXPANDED_NEWEST = 3;

function ThreadMessages({
  threadMails,
  isSingleMail,
  selectedMailId,
  chat,
  isOwn,
  onCollapse,
  onReply,
  onReplyAll,
  onForward,
  onLinkClick,
  onUpdateMail,
}: {
  threadMails: Mail[];
  isSingleMail: boolean;
  selectedMailId?: string;
  chat: boolean;
  isOwn: (mail: Mail) => boolean;
  onCollapse: (mailId: string) => void;
  onReply: (mail: Mail) => void;
  onReplyAll: (mail: Mail) => void;
  onForward: (mail: Mail) => void;
  onLinkClick: (href: string) => void;
  onUpdateMail: (mailId: string, updates: Partial<Mail>) => void;
}) {
  const messagesRef = useRef<HTMLDivElement>(null);

  if (chat && !isSingleMail) {
    const newest = new Set(threadMails.slice(0, CHAT_EXPANDED_NEWEST).map((m) => m.id));
    const oldestFirst = [...threadMails].reverse();
    return (
      <div ref={messagesRef} className="flex flex-col gap-4 pt-3">
        {oldestFirst.map((m, index) => {
          const own = isOwn(m);
          return (
            <div key={m.id} data-mail-id={m.id} className={`message-card flex ${own ? "justify-end" : "justify-start"}`}>
              <MessageCard
                mail={m}
                isLatest={index === oldestFirst.length - 1}
                defaultExpanded={newest.has(m.id) || m.id === selectedMailId || !m.is_read}
                chat
                own={own}
                onCollapse={onCollapse}
                onReply={onReply}
                onReplyAll={onReplyAll}
                onForward={onForward}
                onLinkClick={onLinkClick}
                onUpdateMail={onUpdateMail}
              />
            </div>
          );
        })}
      </div>
    );
  }

  // Cards must never depend on a JS animation to become visible.
  return (
    <div ref={messagesRef} className={isSingleMail ? "space-y-3" : "space-y-4"}>
      {threadMails.map((m, index) => (
        <div key={m.id} data-mail-id={m.id} className="message-card flex gap-3">
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
              defaultExpanded={isSingleMail || index === 0 || m.id === selectedMailId}
              singleMail={isSingleMail}
              onCollapse={onCollapse}
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
  const scrollToMessage = useCallback((mailId: string) => {
    messagesScrollRef.current
      ?.querySelector(`[data-mail-id="${CSS.escape(mailId)}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [messagesScrollRef]);
  // Collapsing while scrolled into a message would leave the reader below it.
  const revealMessageStart = useCallback((mailId: string) => {
    requestAnimationFrame(() => {
      const scroller = messagesScrollRef.current;
      const el = scroller?.querySelector(`[data-mail-id="${CSS.escape(mailId)}"]`);
      if (!scroller || !el) return;
      const offset = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      if (offset < 0) scroller.scrollTop += offset - 12;
    });
  }, [messagesScrollRef]);
  const [threadMails, setThreadMails] = useState<Mail[]>([mail]);
  const [loading, setLoading] = useState(true);
  const openCompose = useAppStore((s) => s.openCompose);
  const setMails = useAppStore((s) => s.setMails);
  const setSelectedMailId = useAppStore((s) => s.setSelectedMailId);
  const setPendingRemoveIds = useAppStore((s) => s.setPendingRemoveIds);
  const folders = useAppStore((s) => s.folders);
  const accounts = useAppStore((s) => s.accounts);
  const chatView = useAppStore((s) => s.appSettings.thread_view === "chat");
  const isOwn = useMemo(
    () => makeIsOutgoing(folders, accounts.map((a) => a.email), null),
    [folders, accounts],
  );
  const messagesContentRef = useRef<HTMLDivElement>(null);
  useChatAnchor(messagesScrollRef, messagesContentRef, mail.id, chatView);
  const selectedFolderId = useAppStore((s) => s.selectedFolderId);
  const addToast = useAppStore((s) => s.addToast);
  const queryClient = useQueryClient();
  const dialog = useDialog();
  const currentFolder = folders.find((f) => f.id === selectedFolderId);
  const isInTrash = currentFolder?.folder_type === "trash";
  const [showAiSummary, setShowAiSummary] = useState(false);
  const [showAiReplies, setShowAiReplies] = useState(false);
  const [taskMenu, setTaskMenu] = useState<{ x: number; y: number } | null>(null);
  const [taskPickerOpen, setTaskPickerOpen] = useState(false);
  const linkedTasks = useMailTasks(mail.id);
  const [taskFromMailOpen, setTaskFromMailOpen] = useState(false);
  const linkMailToTaskMutation = useLinkMailToTask();

  const taskMenuEntries: MenuEntry[] = [
    { kind: "item", id: "createTask", label: t("tasks.createFromMail"), icon: <ClipboardList className="w-4 h-4" />, onSelect: () => setTaskFromMailOpen(true) },
    { kind: "item", id: "addToTask", label: t("tasks.addToTask"), icon: <ClipboardPlus className="w-4 h-4" />, onSelect: () => setTaskPickerOpen(true) },
  ];

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

  // The scroll container survives selection changes; reset it per mail.
  useEffect(() => {
    if (!chatView) messagesScrollRef.current?.scrollTo({ top: 0 });
  }, [mail.id, chatView]);

  // Paint the selected mail immediately; the thread merges in async.
  useEffect(() => {
    let cancelled = false;
    setThreadMails([mail]);
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

  const handleTrash = useCallback(async () => {
    // Only confirm when permanently deleting from trash
    if (isInTrash) {
      const confirmed = await dialog.danger({
        title: t("mailDetail.trash"),
        message: t("mailDetail.permanentDeleteConfirm", { name: mail.subject || t("compose.noSubject") }),
      });
      if (!confirmed) return;
    }
    // Same exit path as archive: the list plays the row sweep and picks the next mail.
    setPendingRemoveIds([mail.id]);
    trashMail(mail.id)
      .then(() => invalidateMailListQueries(queryClient))
      .catch((e) => {
        setPendingRemoveIds([]);
        dialog.alert({ type: "danger", title: t("common.error"), message: causeMessage(e) });
      });
  }, [mail.id, mail.subject, isInTrash, setPendingRemoveIds, dialog, t, queryClient]);

  const handleArchive = useCallback(async () => {
    setPendingRemoveIds([mail.id]);
    archiveMail(mail.id)
      .then(() => invalidateMailListQueries(queryClient))
      .catch((e) => {
        // Same as trash: without this the row stays swept away while the mail
        // is still sitting in the folder.
        setPendingRemoveIds([]);
        dialog.alert({ type: "danger", title: t("common.error"), message: causeMessage(e) });
      });
  }, [mail.id, setPendingRemoveIds, dialog, t, queryClient]);

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

  const openCheckedLink = useOpenCheckedLink();
  const handleLinkClick = useCallback((href: string) => {
    if (href.startsWith("mailto:")) {
      useAppStore.getState().openMailto(href);
      return;
    }
    openCheckedLink(href);
  }, [openCheckedLink]);

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
      dialog.alert({ type: "danger", title: t("common.error"), message: causeMessage(e) });
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
    <div className="relative isolate flex flex-col h-full bg-bg-secondary">
      <ReadingAmbient />
      <div className="px-5 py-3 bg-surface border-b border-border">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            {/* Zweizeilig statt einzeilig abgeschnitten: ein langer Betreff
                endet sonst mitten im Wort, und dies ist die einzige Stelle, an
                der er ueberhaupt vollstaendig steht. title zeigt ihn ganz. */}
            <h2 title={mail.subject} className="text-base font-semibold text-text leading-snug line-clamp-2 select-text">{mail.subject}</h2>
            {!isSingleMail && (
              <span className="inline-flex items-center gap-1.5 mt-1 text-xs text-text-tertiary">
                <MessageSquare className="w-3.5 h-3.5" />
                {t("mailDetail.message", { count: threadCount })}
              </span>
            )}
          </div>

          {/* Aktionen teilen sich die Kopfzeile, statt eine eigene zu belegen —
              shrink-0, damit ein langer Betreff sie nie zusammendrueckt. */}
          <div className="flex items-center gap-0.5 shrink-0">
            <Tooltip label={t("mailDetail.reply")}>
              <button
                aria-label={t("mailDetail.reply")}
                onClick={() => openCompose("reply", mail)}
                className="p-2 rounded-lg hover:bg-hover transition-colors text-text-secondary"
              >
                <Reply className="w-5 h-5" />
              </button>
            </Tooltip>
            <Tooltip label={t("mailDetail.replyAll")}>
              <button
                aria-label={t("mailDetail.replyAll")}
                onClick={() => openCompose("replyAll", mail)}
                className="p-2 rounded-lg hover:bg-hover transition-colors text-text-secondary"
              >
                <ReplyAll className="w-5 h-5" />
              </button>
            </Tooltip>
            <Tooltip label={t("mailDetail.forward")}>
              <button
                aria-label={t("mailDetail.forward")}
                onClick={() => openCompose("forward", mail)}
                className="p-2 rounded-lg hover:bg-hover transition-colors text-text-secondary"
              >
                <Forward className="w-5 h-5" />
              </button>
            </Tooltip>
            <Tooltip label={t("tasks.title")}>
              <button
                aria-label={t("tasks.title")}
                aria-haspopup="menu"
                aria-expanded={taskMenu !== null}
                // While the menu is open its outside-mousedown handler would close it
                // right before this click could toggle it back open.
                onMouseDown={(e) => { if (taskMenu) e.stopPropagation(); }}
                onClick={(e) => {
                  const r = e.currentTarget.getBoundingClientRect();
                  setTaskMenu((open) => (open ? null : { x: r.left, y: r.bottom + 4 }));
                }}
                className="p-2 rounded-lg hover:bg-hover transition-colors text-text-secondary"
              >
                <ClipboardList className="w-5 h-5" />
              </button>
            </Tooltip>
            <Tooltip label={t("mailDetail.print")}>
              <button
                aria-label={t("mailDetail.print")}
                onClick={handlePrint}
                className="p-2 rounded-lg hover:bg-hover transition-colors text-text-secondary"
              >
                <Printer className="w-5 h-5" />
              </button>
            </Tooltip>
            <Tooltip label={t("mailDetail.archiveConversation")}>
              <button
                aria-label={t("mailDetail.archiveConversation")}
                onClick={handleArchive}
                className="p-2 rounded-lg hover:bg-hover transition-colors text-text-secondary"
              >
                <Archive className="w-5 h-5" />
              </button>
            </Tooltip>
            <Tooltip label={t("mailDetail.deleteConversation")}>
              <button
                aria-label={t("mailDetail.deleteConversation")}
                onClick={handleTrash}
                className="p-2 rounded-lg hover:bg-hover transition-colors text-text-secondary"
              >
                <TrashIcon size={20} strokeWidth={2} dangerHover />
              </button>
            </Tooltip>
            <div className="w-px h-4 bg-border mx-0.5" />
            <AiSummaryButton mailId={mail.id} threadMode={!isSingleMail} onToggle={() => setShowAiSummary((v) => !v)} active={showAiSummary} />
            <AiReplyButton mailId={latestMail.id} onToggle={() => setShowAiReplies((v) => !v)} active={showAiReplies} />
            {mail.list_unsubscribe && (
              <Tooltip label={t("unsubscribe.title")}>
              <button
                aria-label={t("unsubscribe.title")}
                onClick={handleUnsubscribe}
                className="p-2 rounded-lg hover:bg-hover transition-colors text-text-secondary"
              >
                <MailMinus className="w-5 h-5" />
              </button>
              </Tooltip>
            )}
          </div>
        </div>

        {linkedTasks.data && linkedTasks.data.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5 mt-2">
            {linkedTasks.data.map((task) => (
              <LinkedTaskChip key={task.id} task={task} />
            ))}
          </div>
        )}
      </div>

      {showAiSummary && <AiSummaryPanel mailId={mail.id} threadMode={!isSingleMail} />}
      {showAiReplies && <AiReplySuggestionsPanel mailId={latestMail.id} threadMode={!isSingleMail} />}

      {!isSingleMail && <ThreadAttachments threadMails={threadMails} loading={loading} onLocate={scrollToMessage} />}

      <div ref={messagesScrollRef} className="relative flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-4">
        {/* Reading measure: on a maximized window plain-text mails otherwise
            stretch across the full pane width. HTML newsletters bring their
            own (narrower) layout and are unaffected. */}
        {/* Chat bubbles cap their own width; the free space belongs between the sides. */}
        <div ref={messagesContentRef} className={`mx-auto w-full ${chatView && !isSingleMail ? "max-w-7xl" : "max-w-[840px]"}`}>
          <ThreadMessages
            threadMails={threadMails}
            isSingleMail={isSingleMail}
            selectedMailId={mail.id}
            chat={chatView}
            isOwn={isOwn}
            onCollapse={revealMessageStart}
            onReply={handleReply}
            onReplyAll={handleReplyAll}
            onForward={handleForward}
            onLinkClick={handleLinkClick}
            onUpdateMail={handleUpdateThreadMail}
          />
        </div>
      </div>

      {taskMenu && (
        <ContextMenu entries={taskMenuEntries} x={taskMenu.x} y={taskMenu.y} onClose={() => setTaskMenu(null)} ariaLabel={t("tasks.title")} />
      )}

      {taskPickerOpen && (
        <TaskPickerDialog
          open
          onClose={() => setTaskPickerOpen(false)}
          onPick={(taskId) => linkMailToTaskMutation.mutate({ taskId, mailId: mail.id })}
          excludeTaskIds={linkedTasks.data?.map((task) => task.id)}
        />
      )}

      {taskFromMailOpen && (
        <CreateTaskFromMail mailId={mail.id} onDone={() => setTaskFromMailOpen(false)} />
      )}
    </div>
  );
}
