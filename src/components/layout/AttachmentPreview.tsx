import { useState, useEffect, useRef } from "react";
import { X, Download, Mail, ChevronLeft, ChevronRight, FileText, Image, FileSpreadsheet, File, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { convertFileSrc } from "@tauri-apps/api/core";
import { getAttachmentPreview } from "../../lib/tauri";
import type { AttachmentWithContext } from "../../types";
import { formatMailDate } from "../../lib/dateUtils";
import { useAppStore } from "../../stores/appStore";

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "tiff"]);
const PDF_EXTENSIONS = new Set(["pdf"]);

function getFileCategory(att: AttachmentWithContext): "image" | "pdf" | "other" {
  const ext = att.filename.split(".").pop()?.toLowerCase() || "";
  const mime = att.mime_type?.toLowerCase() || "";
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) return "image";
  if (mime === "application/pdf" || PDF_EXTENSIONS.has(ext)) return "pdf";
  return "other";
}

function getLargeFileIcon(att: AttachmentWithContext) {
  const ext = att.filename.split(".").pop()?.toLowerCase() || "";
  const mime = att.mime_type?.toLowerCase() || "";
  if (mime.startsWith("image/") || IMAGE_EXTENSIONS.has(ext)) {
    return <Image className="w-16 h-16 text-emerald-500/60" />;
  }
  if (mime === "application/pdf" || ext === "pdf") {
    return <FileText className="w-16 h-16 text-red-500/60" />;
  }
  if (mime.includes("spreadsheet") || mime.includes("excel") || ["xlsx", "xls", "csv"].includes(ext)) {
    return <FileSpreadsheet className="w-16 h-16 text-green-600/60" />;
  }
  if (mime.includes("word") || mime.includes("document") || ["docx", "doc"].includes(ext)) {
    return <FileText className="w-16 h-16 text-blue-600/60" />;
  }
  return <File className="w-16 h-16 text-text-tertiary/60" />;
}

interface AttachmentPreviewProps {
  width: number;
  attachment: AttachmentWithContext;
  onClose: () => void;
  onDownload: (att: AttachmentWithContext) => void;
  onOpenMail: (att: AttachmentWithContext) => void;
  onPrev: () => void;
  onNext: () => void;
  hasPrev: boolean;
  hasNext: boolean;
  onExpandImage?: () => void;
}

export function AttachmentPreview({
  width,
  attachment,
  onClose,
  onDownload,
  onOpenMail,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  onExpandImage,
}: AttachmentPreviewProps) {
  const { t } = useTranslation();
  const appSettings = useAppStore((s) => s.appSettings);
  const category = getFileCategory(attachment);

  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const blobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    if (!attachment.local_path || category !== "pdf") {
      setPdfBlobUrl(null);
      setLoading(false);
      setFailed(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setPdfBlobUrl(null);

    getAttachmentPreview(attachment.id)
      .then((url) => {
        if (cancelled) return;
        if (url) {
          // Convert data URL to blob URL to bypass the ~2 MB
          // data-URL navigation limit in Chromium/WebView2
          const match = url.match(/^data:([^;]+);base64,(.+)$/);
          if (match) {
            const byteString = atob(match[2]);
            const bytes = new Uint8Array(byteString.length);
            for (let i = 0; i < byteString.length; i++) {
              bytes[i] = byteString.charCodeAt(i);
            }
            // Force the PDF mime type: many mailers/scanners attach PDFs as
            // application/octet-stream (or x-pdf), which the WebView2 viewer
            // refuses to render inline — it triggers a download instead, so
            // the preview silently stays blank. Category is already
            // extension-checked, so the content is known to be a PDF here.
            const blob = new Blob([bytes], { type: "application/pdf" });
            if (blobUrlRef.current) URL.revokeObjectURL(blobUrlRef.current);
            const blobUrl = URL.createObjectURL(blob);
            blobUrlRef.current = blobUrl;
            setPdfBlobUrl(blobUrl);
          } else {
            setFailed(true);
          }
        } else {
          setFailed(true);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
      if (blobUrlRef.current) {
        URL.revokeObjectURL(blobUrlRef.current);
        blobUrlRef.current = null;
      }
    };
  }, [attachment.id, attachment.local_path, category]);

  const renderPreviewContent = () => {
    if (!attachment.local_path) {
      return (
        <div className="flex flex-col items-center gap-3 text-text-tertiary px-6">
          {getLargeFileIcon(attachment)}
          <span className="text-sm">{t("attachments.fileNotLocal")}</span>
        </div>
      );
    }

    if (category === "other") {
      return (
        <div className="flex flex-col items-center gap-3 text-text-tertiary px-6">
          {getLargeFileIcon(attachment)}
          <span className="text-sm font-medium text-text">{attachment.filename}</span>
          <span className="text-xs">{t("attachments.noPreview")}</span>
        </div>
      );
    }

    // Images: use Tauri asset protocol (no temp files, no base64 overhead)
    if (category === "image") {
      return (
        <img
          src={convertFileSrc(attachment.local_path)}
          alt={attachment.filename}
          className="max-w-full max-h-full object-contain p-4"
          draggable={false}
          style={{ cursor: onExpandImage ? "zoom-in" : "default" }}
          onClick={onExpandImage}
        />
      );
    }

    // PDFs: use blob URL (WebView2 PDF viewer needs this)
    // The on_download handler in lib.rs redirects the temp file away from Downloads
    if (category === "pdf") {
      if (loading) {
        return <Loader2 className="w-6 h-6 text-accent animate-spin" />;
      }
      if (failed || !pdfBlobUrl) {
        return (
          <div className="flex flex-col items-center gap-3 text-text-tertiary px-6">
            {getLargeFileIcon(attachment)}
            <span className="text-sm">{t("attachments.noPreview")}</span>
          </div>
        );
      }
      return (
        <iframe
          src={pdfBlobUrl}
          className="w-full h-full border-0"
          title={attachment.filename}
        />
      );
    }

    return null;
  };

  return (
    <div style={{ width }} className="shrink-0 bg-surface flex flex-col h-full">
      <div className="flex items-center gap-2 px-4 py-3 border-b border-border min-w-0">
        <span className="truncate flex-1 text-sm font-medium text-text">{attachment.filename}</span>
        <button
          onClick={onClose}
          className="p-1 rounded-md hover:bg-hover text-text-tertiary hover:text-text transition-colors shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative flex items-center justify-center bg-bg-secondary overflow-hidden">
        {hasPrev && (
          <button
            onClick={onPrev}
            className="absolute left-2 top-1/2 -translate-y-1/2 z-10 p-1.5 rounded-full bg-surface/80 backdrop-blur-sm border border-border shadow-sm hover:bg-hover text-text-secondary hover:text-text transition-colors"
            title={t("attachments.prevAttachment")}
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
        {hasNext && (
          <button
            onClick={onNext}
            className="absolute right-2 top-1/2 -translate-y-1/2 z-10 p-1.5 rounded-full bg-surface/80 backdrop-blur-sm border border-border shadow-sm hover:bg-hover text-text-secondary hover:text-text transition-colors"
            title={t("attachments.nextAttachment")}
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        )}

        {renderPreviewContent()}
      </div>

      <div className="border-t border-border px-4 py-3 space-y-3">
        <div className="space-y-1 text-xs text-text-secondary">
          {attachment.size_bytes != null && (
            <div className="flex justify-between">
              <span className="text-text-tertiary">{t("attachments.colSize")}</span>
              <span>{formatFileSize(attachment.size_bytes)}</span>
            </div>
          )}
          <div className="flex justify-between">
            <span className="text-text-tertiary">{t("attachments.colFrom")}</span>
            <span className="truncate ml-4 text-right">{attachment.mail_from_name || attachment.mail_from_email}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">{t("attachments.colSubject")}</span>
            <span className="truncate ml-4 text-right">{attachment.mail_subject}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-text-tertiary">{t("attachments.colDate")}</span>
            <span>{formatMailDate(attachment.mail_date, appSettings.use_24h_clock)}</span>
          </div>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => onDownload(attachment)}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg border border-border text-xs font-medium text-text hover:bg-hover transition-colors"
          >
            <Download className="w-3.5 h-3.5" />
            {t("attachments.downloadSelected").replace(/ .*/, "")}
          </button>
          <button
            onClick={() => onOpenMail(attachment)}
            className="flex-1 flex items-center justify-center gap-2 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors"
          >
            <Mail className="w-3.5 h-3.5" />
            {t("attachments.openInMail")}
          </button>
        </div>
      </div>
    </div>
  );
}
