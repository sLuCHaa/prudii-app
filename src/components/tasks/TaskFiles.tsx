import { useTranslation } from "react-i18next";
import { Loader2, FolderOpen, X, Plus } from "lucide-react";
import type { TaskAttachment } from "../../types";
import type { useTaskAttachments } from "../../hooks/useTasks";
import { useAppStore } from "../../stores/appStore";
import { revealLabelKey } from "../../lib/attachmentActions";
import { isMacOS, isWindows } from "../../lib/platform";
import { SECTION_ACTION, TaskSectionHead } from "./TaskSectionHead";

// Tinted chips, not solid fills: white-on-solid breaks against a re-themed accent
// and reads far louder than the due chip it sits next to.
const TYPE_FAMILIES: { extensions: RegExp; className: string }[] = [
  { extensions: /^pdf$/, className: "bg-danger/12 text-danger" },
  { extensions: /^(jpg|jpeg|png|gif|webp|heic|heif|bmp|svg|tif|tiff|avif)$/, className: "bg-accent/12 text-accent" },
  { extensions: /^(xls|xlsx|xlsm|csv|ods|numbers)$/, className: "bg-success/12 text-success" },
  { extensions: /^(zip|rar|7z|tar|gz|bz2|xz)$/, className: "bg-warning/15 text-warning" },
  { extensions: /^(doc|docx|odt|rtf|txt|md|pages|ppt|pptx|key|odp)$/, className: "bg-text-secondary/12 text-text-secondary" },
];

/** Extension badge: short uppercase label plus a tint per file family. */
export function fileBadge(filename: string): { label: string; className: string } {
  const dot = filename.lastIndexOf(".");
  const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
  const family = TYPE_FAMILIES.find((f) => f.extensions.test(ext));
  return {
    label: (ext || "file").slice(0, 4).toUpperCase(),
    className: family?.className ?? "bg-text-tertiary/12 text-text-tertiary",
  };
}

function formatFileSize(bytes: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface TaskFilesProps {
  attachments: TaskAttachment[];
  api: ReturnType<typeof useTaskAttachments>;
  /** True while an OS file drag hovers the drawer — highlights the drop row. */
  dropActive?: boolean;
}

/** Single-column file list. The OS-file drop handler lives on TaskDrawer's root
 *  (covers the whole panel) and shares this same `api` instance so pending state stays in sync. */
export function TaskFiles({ attachments, api, dropActive = false }: TaskFilesProps) {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const revealLabel = t(revealLabelKey({ isMac: isMacOS, isWindows }));

  function handleOpen(id: string) {
    api.open.mutate(id, {
      onError: (err) => addToast("error", t("errors.attachmentOpen"), err instanceof Error ? err.message : String(err)),
    });
  }

  return (
    <div>
      <TaskSectionHead
        title={t("tasks.attachments")}
        count={attachments.length}
        action={
          <button onClick={() => api.add.mutate()} disabled={api.add.isPending} className={SECTION_ACTION}>
            {api.add.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            {t("tasks.addFiles")}
          </button>
        }
      />
      <div className="grid grid-cols-1 gap-1.5">
        {attachments.map((att) => {
          const badge = fileBadge(att.filename);
          return (
            <div
              key={att.id}
              className="grid grid-cols-[34px_1fr_auto] items-center gap-2.5 px-2.5 py-2 rounded-xl border border-border-light bg-surface hover:border-border transition-colors group min-w-0"
              draggable
              onDragStart={(e) => {
                // HTML5 drag cannot hand a file to the OS; the native session takes over.
                e.preventDefault();
                api.startDrag.mutate(att.id);
              }}
            >
              <span
                aria-hidden
                className={`w-[34px] h-10 rounded-[7px] grid place-items-center text-[9.5px] font-bold tracking-wide ${badge.className}`}
              >
                {badge.label}
              </span>
              <button onClick={() => handleOpen(att.id)} aria-label={t("tasks.openFile")} className="min-w-0 text-left">
                <div className="truncate text-[13px] font-medium text-text" title={att.filename}>{att.filename}</div>
                {att.size_bytes > 0 && (
                  <div className="text-[11.5px] text-text-tertiary tabular-nums">{formatFileSize(att.size_bytes)}</div>
                )}
              </button>
              <div className="flex items-center gap-0.5">
                <button
                  onClick={(e) => { e.stopPropagation(); api.reveal.mutate(att.id); }}
                  className="p-1 rounded-md opacity-0 group-hover:opacity-100 text-text-tertiary hover:bg-hover hover:text-text transition-colors"
                  aria-label={revealLabel}
                  title={revealLabel}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); api.remove.mutate(att.id); }}
                  className="p-1 rounded-md opacity-0 group-hover:opacity-100 text-text-tertiary hover:bg-hover hover:text-danger transition-colors"
                  aria-label={t("tasks.removeFile")}
                  title={t("tasks.removeFile")}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
        <div
          className={`rounded-xl border-[1.5px] border-dashed px-2.5 py-2.5 text-center text-xs transition-colors ${
            dropActive ? "border-accent bg-accent/10 text-accent" : "border-border text-text-tertiary"
          }`}
        >
          {t("tasks.addFilesHint")}
        </div>
      </div>
    </div>
  );
}
