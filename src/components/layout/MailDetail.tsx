import { useEffect, useState, useRef, useCallback, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../../stores/appStore";
import { markAsRead, getMail } from "../../lib/tauri";
import { MAIL_LINK_BRIDGE, MAIL_LINK_BRIDGE_CSP_HASH } from "../../lib/mailLinkBridge";
import { openMailUrl } from "../../lib/trackingParams";
import { EmptyState } from "../ui/EmptyState";
import { DaylightSky, useAtmosphereLine } from "../motion/DaylightSky";
import { ThreadView } from "./ThreadView";
import { sanitizeEmailHtml, type TrackerInfo } from "../../lib/sanitize";
import { useTranslation } from "react-i18next";
import type { Mail } from "../../types";


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
