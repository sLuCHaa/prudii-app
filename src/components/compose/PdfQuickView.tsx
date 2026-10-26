import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { formatFileSize } from "../../lib/fileSize";

export interface PdfQuickViewItem {
  id: string;
  name: string;
  data: string; // base64
  size: number;
}

interface PdfQuickViewProps {
  items: PdfQuickViewItem[];
  initialIndex: number;
  onClose: () => void;
}

export function PdfQuickView({ items, initialIndex, onClose }: PdfQuickViewProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(initialIndex);
  const [url, setUrl] = useState<string | null>(null);
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  const current = items[index];
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  useEffect(() => {
    if (index >= items.length) setIndex(Math.max(0, items.length - 1));
  }, [items.length, index]);

  useEffect(() => {
    if (!current) return;
    const bytes = Uint8Array.from(atob(current.data), (c) => c.charCodeAt(0));
    // Blob URL, not data:, past Chromium's ~2 MB data-URL navigation limit; the
    // forced type keeps WebView2 from downloading octet-stream PDFs instead.
    const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    setUrl(blobUrl);
    return () => URL.revokeObjectURL(blobUrl);
  }, [current]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowLeft" && hasPrev) { e.preventDefault(); setIndex((i) => i - 1); return; }
      if (e.key === "ArrowRight" && hasNext) { e.preventDefault(); setIndex((i) => i + 1); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, hasPrev, hasNext]);

  if (!current) return null;

  return createPortal(
    <div
      ref={trapRef}
      role="dialog"
      aria-modal="true"
      aria-label={current.name}
      className="fixed inset-0 z-100 bg-black/85 backdrop-blur-sm flex flex-col"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex items-center gap-3 px-4 py-3 text-white">
        <span className="flex-1 truncate text-sm font-medium">{current.name}</span>
        <span className="text-xs text-white/70">{formatFileSize(current.size)}</span>
        {items.length > 1 && (
          <span className="text-xs text-white/70 tabular-nums">
            {t("imageLightbox.counter", { current: index + 1, total: items.length })}
          </span>
        )}
        <button
          onClick={onClose}
          className="p-1.5 rounded-md hover:bg-white/10 transition-colors"
          aria-label={t("imageLightbox.close")}
        >
          <X className="w-5 h-5" />
        </button>
      </div>

      <div className="flex-1 min-h-0 relative flex items-center justify-center px-16 pb-6">
        {hasPrev && (
          <button
            onClick={() => setIndex((i) => i - 1)}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            aria-label={t("attachments.prevAttachment")}
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}
        {hasNext && (
          <button
            onClick={() => setIndex((i) => i + 1)}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            aria-label={t("attachments.nextAttachment")}
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        )}
        {url && <iframe src={url} title={current.name} className="w-full max-w-4xl h-full rounded-lg border-0 bg-white" />}
      </div>
    </div>,
    document.body,
  );
}
