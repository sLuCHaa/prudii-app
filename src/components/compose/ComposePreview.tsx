import { useEffect } from "react";
import { X, Paperclip } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { IconButton } from "../ui/Button";
import { HtmlMailFrame } from "../layout/MailDetail";

export interface ComposePreviewData {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  attachments: string[];
  /** The body exactly as buildOutgoingBody hands it to the send path. */
  html: string;
}

export function ComposePreview({ data, onClose }: { data: ComposePreviewData; onClose: () => void }) {
  const { t } = useTranslation();

  // Keystrokes inside the mail frame stay in the iframe, so this only sees
  // Escape while focus is on the dialog chrome — the close button covers the rest.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const rows: [string, string][] = [
    [t("compose.from"), data.from],
    [t("compose.to"), data.to.join(", ")],
    ...(data.cc.length > 0 ? [[t("compose.cc"), data.cc.join(", ")] as [string, string]] : []),
    ...(data.bcc.length > 0 ? [[t("compose.bcc"), data.bcc.join(", ")] as [string, string]] : []),
    [t("compose.subject"), data.subject.trim() || t("compose.noSubject")],
  ];

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="fixed inset-0 z-60 flex items-center justify-center p-4 modal-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.97 }}
        animate={{ opacity: 1, scale: 1 }}
        role="dialog"
        aria-modal="true"
        aria-label={t("compose.preview")}
        className="bg-surface rounded-xl shadow-lg w-full max-w-3xl max-h-full flex flex-col overflow-hidden"
      >
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-bg-secondary inset-shadow-edge">
          <h3 className="text-sm font-semibold text-text">{t("compose.preview")}</h3>
          <IconButton icon={<X />} size="sm" aria-label={t("common.close")} onClick={onClose} />
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 px-4 py-3 border-b border-border-light text-sm">
          {rows.map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-text-tertiary">{label}</dt>
              <dd className="text-text break-words min-w-0">{value}</dd>
            </div>
          ))}
          {data.attachments.length > 0 && (
            <div className="contents">
              <dt className="text-text-tertiary"><Paperclip className="w-3.5 h-3.5 mt-1" aria-label={t("compose.previewAttachments")} /></dt>
              <dd className="text-text-secondary break-words min-w-0">{data.attachments.join(", ")}</dd>
            </div>
          )}
        </dl>
        <div className="flex-1 min-h-0 overflow-y-auto bg-white">
          <HtmlMailFrame html={data.html} allowExternalImages={true} forceLight={true} />
        </div>
        <p className="px-4 py-2 text-xs text-text-tertiary border-t border-border-light bg-bg-secondary">
          {t("compose.previewHint")}
        </p>
      </motion.div>
    </motion.div>
  );
}
