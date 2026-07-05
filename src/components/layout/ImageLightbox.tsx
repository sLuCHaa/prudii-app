import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X, ChevronLeft, ChevronRight, Download } from "lucide-react";
import { useTranslation } from "react-i18next";

export interface ImageLightboxItem {
  id: string;
  filename: string;
  src: string;
  sizeBytes: number | null;
  canDownload: boolean;
}

interface ImageLightboxProps {
  images: ImageLightboxItem[];
  initialIndex: number;
  onClose: () => void;
  onDownload: (id: string) => void;
}

function formatFileSize(bytes: number | null): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function ImageLightbox({ images, initialIndex, onClose, onDownload }: ImageLightboxProps) {
  const { t } = useTranslation();
  const [index, setIndex] = useState(initialIndex);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);
  const [scale, setScale] = useState(1);
  const [tx, setTx] = useState(0);
  const [ty, setTy] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const panStart = useRef<{ x: number; y: number; tx: number; ty: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const current = images[index];
  const hasPrev = index > 0;
  const hasNext = index < images.length - 1;

  useEffect(() => {
    setDims(null);
    setScale(1);
    setTx(0);
    setTy(0);
  }, [index]);

  useEffect(() => {
    if (index >= images.length) setIndex(Math.max(0, images.length - 1));
  }, [images.length, index]);

  function clampScale(s: number) { return Math.max(1, Math.min(8, s)); }

  function zoomAt(deltaScale: number, clientX: number, clientY: number) {
    const el = containerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    const ix = (clientX - cx - tx) / scale;
    const iy = (clientY - cy - ty) / scale;
    const newScale = clampScale(scale + deltaScale);
    if (newScale === scale) return;
    const newTx = (clientX - cx) - ix * newScale;
    const newTy = (clientY - cy) - iy * newScale;
    setScale(newScale);
    setTx(newScale === 1 ? 0 : newTx);
    setTy(newScale === 1 ? 0 : newTy);
  }

  function onWheel(e: React.WheelEvent) {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -0.2 : 0.2;
    zoomAt(delta, e.clientX, e.clientY);
  }

  function onDoubleClickImage(e: React.MouseEvent) {
    e.stopPropagation();
    if (scale > 1) {
      setScale(1); setTx(0); setTy(0);
    } else {
      zoomAt(1, e.clientX, e.clientY);
    }
  }

  function onMouseDown(e: React.MouseEvent) {
    if (scale <= 1) return;
    e.preventDefault();
    setIsPanning(true);
    panStart.current = { x: e.clientX, y: e.clientY, tx, ty };
  }

  useEffect(() => {
    if (!isPanning) return;
    function onMove(e: MouseEvent) {
      if (!panStart.current) return;
      setTx(panStart.current.tx + (e.clientX - panStart.current.x));
      setTy(panStart.current.ty + (e.clientY - panStart.current.y));
    }
    function onUp() { setIsPanning(false); panStart.current = null; }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [isPanning]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { e.preventDefault(); onClose(); return; }
      if (e.key === "ArrowLeft") { e.preventDefault(); if (hasPrev) setIndex((i) => i - 1); return; }
      if (e.key === "ArrowRight") { e.preventDefault(); if (hasNext) setIndex((i) => i + 1); return; }
      if (e.key === "+" || e.key === "=") {
        e.preventDefault();
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) zoomAt(0.5, rect.left + rect.width / 2, rect.top + rect.height / 2);
        return;
      }
      if (e.key === "-") {
        e.preventDefault();
        const rect = containerRef.current?.getBoundingClientRect();
        if (rect) zoomAt(-0.5, rect.left + rect.width / 2, rect.top + rect.height / 2);
        return;
      }
      if (e.key === "0") { e.preventDefault(); setScale(1); setTx(0); setTy(0); return; }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, hasPrev, hasNext, scale, tx, ty]);

  if (!current) return null;

  function goPrev() { if (hasPrev) setIndex((i) => i - 1); }
  function goNext() { if (hasNext) setIndex((i) => i + 1); }

  return createPortal(
    <div
      className="fixed inset-0 z-100 bg-black/85 backdrop-blur-sm flex flex-col"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="flex items-center gap-3 px-4 py-3 text-white">
        <span className="flex-1 truncate text-sm font-medium">{current.filename}</span>
        {images.length > 1 && (
          <span className="text-xs text-white/70 tabular-nums">
            {t("imageLightbox.counter", { current: index + 1, total: images.length })}
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

      <div
        ref={containerRef}
        className="flex-1 min-h-0 relative flex items-center justify-center overflow-hidden"
        onWheel={onWheel}
        onMouseDown={onMouseDown}
        style={{ cursor: scale > 1 ? (isPanning ? "grabbing" : "grab") : "default" }}
      >
        {hasPrev && (
          <button
            onClick={goPrev}
            className="absolute left-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            aria-label={t("imageLightbox.previous")}
          >
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}
        {hasNext && (
          <button
            onClick={goNext}
            className="absolute right-4 top-1/2 -translate-y-1/2 z-10 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition-colors"
            aria-label={t("imageLightbox.next")}
          >
            <ChevronRight className="w-6 h-6" />
          </button>
        )}

        <img
          src={current.src}
          alt={current.filename}
          className="max-w-full max-h-full object-contain select-none"
          draggable={false}
          onLoad={(e) => {
            const img = e.currentTarget;
            setDims({ w: img.naturalWidth, h: img.naturalHeight });
          }}
          onDoubleClick={onDoubleClickImage}
          style={{
            transform: `translate(${tx}px, ${ty}px) scale(${scale})`,
            transition: isPanning ? "none" : "transform 80ms ease-out",
            transformOrigin: "center center",
          }}
        />
      </div>

      <div className="flex items-center gap-4 px-4 py-3 text-xs text-white/80">
        <div className="flex-1 flex items-center gap-3">
          {current.sizeBytes != null && <span>{formatFileSize(current.sizeBytes)}</span>}
          {dims && <span>{t("imageLightbox.dimensions", { width: dims.w, height: dims.h })}</span>}
        </div>
        {current.canDownload && (
          <button
            onClick={() => onDownload(current.id)}
            className="flex items-center gap-2 px-3 py-1.5 rounded-md bg-white/10 hover:bg-white/20 transition-colors"
          >
            <Download className="w-4 h-4" />
            <span>{t("imageLightbox.download")}</span>
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
}
