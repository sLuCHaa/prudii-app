import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Paperclip } from "lucide-react";
import type { Attachment } from "../../types";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { attachmentPickOrder, defaultPickedAttachmentIds } from "../../lib/tasks";
import { formatFileSize } from "../../lib/fileSize";

export interface MailAttachmentPickDialogProps {
  attachments: Attachment[];
  /** Picked ids, in the order the list shows them. Empty means "create without files". */
  onConfirm: (attachmentIds: string[]) => void;
  onCancel: () => void;
}

export function MailAttachmentPickDialog({ attachments, onConfirm, onCancel }: MailAttachmentPickDialogProps) {
  const { t } = useTranslation();
  const panelRef = useFocusTrap<HTMLDivElement>(true, { initialFocus: false });

  const items = useMemo(() => attachmentPickOrder(attachments), [attachments]);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(defaultPickedAttachmentIds(attachments)));

  const allPicked = items.length > 0 && items.every((a) => picked.has(a.id));

  function toggle(id: string) {
    setPicked((prev) => {
      const next = new Set(prev);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function confirm() {
    onConfirm(items.filter((a) => picked.has(a.id)).map((a) => a.id));
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // The mail list keeps window-level single-key shortcuts; as a modal this
    // dialog swallows them (see TaskPickerDialog for the same guard).
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.stopPropagation();
    if (e.key !== "Escape") return;
    e.preventDefault();
    onCancel();
  }

  return createPortal(
    <div
      className="fixed inset-0 z-100 modal-backdrop flex items-start justify-center pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("tasks.attachFromMailTitle")}
        onKeyDown={onKeyDown}
        className="menu-enter w-[440px] max-w-[92vw] overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
      >
        <div className="border-b border-border px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
            <Paperclip className="w-4 h-4 shrink-0 text-text-tertiary" />
            {t("tasks.attachFromMailTitle")}
          </h2>
          <p className="mt-1 text-xs text-text-tertiary">{t("tasks.attachFromMailDesc")}</p>
        </div>

        <div className="max-h-[min(50vh,320px)] overflow-y-auto py-1">
          {items.map((att) => (
            <label
              key={att.id}
              className="flex w-full cursor-pointer items-center gap-2.5 px-4 py-1.5 text-sm transition-colors hover:bg-hover"
            >
              <input
                type="checkbox"
                checked={picked.has(att.id)}
                onChange={() => toggle(att.id)}
                className="shrink-0 accent-[var(--c-accent)]"
              />
              <span className="min-w-0 flex-1 truncate text-text">{att.filename}</span>
              {att.is_inline && (
                <span className="shrink-0 rounded bg-bg-secondary px-1.5 py-0.5 text-[10px] text-text-tertiary">
                  {t("tasks.attachInline")}
                </span>
              )}
              <span className="shrink-0 text-xs tabular-nums text-text-tertiary">{formatFileSize(att.size_bytes)}</span>
            </label>
          ))}
        </div>

        <div className="flex items-center gap-2 border-t border-border px-4 py-3">
          <button
            type="button"
            onClick={() => setPicked(allPicked ? new Set() : new Set(items.map((a) => a.id)))}
            className="rounded-md px-2 py-1 text-xs text-text-secondary transition-colors hover:bg-hover"
          >
            {allPicked ? t("tasks.attachSelectNone") : t("tasks.attachSelectAll")}
          </button>
          <button
            type="button"
            onClick={() => onConfirm([])}
            className="ml-auto rounded-md px-3 py-1.5 text-xs text-text-secondary transition-colors hover:bg-hover"
          >
            {t("tasks.attachSkip")}
          </button>
          <button
            type="button"
            autoFocus
            onClick={confirm}
            className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent/90"
          >
            {t("tasks.attachConfirm")}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
