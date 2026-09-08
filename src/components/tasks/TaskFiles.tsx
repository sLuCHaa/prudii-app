import { useTranslation } from "react-i18next";
import { FileText, Image as ImageIcon, Film, Music, File as FileIcon, Loader2, FolderOpen, X, Plus } from "lucide-react";
import type { TaskAttachment } from "../../types";
import type { useTaskAttachments } from "../../hooks/useTasks";
import { useAppStore } from "../../stores/appStore";
import { revealLabelKey } from "../../lib/attachmentActions";
import { isMacOS, isWindows } from "../../lib/platform";

function getFileIcon(mimeType: string) {
  if (mimeType.startsWith("image/")) return ImageIcon;
  if (mimeType.startsWith("video/")) return Film;
  if (mimeType.startsWith("audio/")) return Music;
  if (mimeType.includes("pdf") || mimeType.includes("document") || mimeType.includes("text")) return FileText;
  return FileIcon;
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
}

/** Tile row + add button. The OS-file drop zone lives on TaskDrawer's root (covers
 *  the whole panel) and shares this same `api` instance so pending state stays in sync. */
export function TaskFiles({ attachments, api }: TaskFilesProps) {
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
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">{t("tasks.attachments")}</h3>
      {attachments.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mb-2">
          {attachments.map((att) => {
            const Icon = getFileIcon(att.mime_type);
            return (
              <div
                key={att.id}
                className="flex items-center gap-2 px-3 py-2 rounded-lg border border-border hover:bg-hover transition-colors group text-xs max-w-full min-w-0"
                draggable
                onDragStart={(e) => {
                  // HTML5 drag cannot hand a file to the OS; the native session takes over.
                  e.preventDefault();
                  api.startDrag.mutate(att.id);
                }}
              >
                <button onClick={() => handleOpen(att.id)} aria-label={t("tasks.openFile")} className="flex items-center gap-1.5 text-left min-w-0 flex-1">
                  <Icon className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
                  <span className="text-text truncate" title={att.filename}>{att.filename}</span>
                  {att.size_bytes > 0 && <span className="text-text-tertiary shrink-0">{formatFileSize(att.size_bytes)}</span>}
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); api.reveal.mutate(att.id); }}
                  className="p-1 rounded hover:bg-hover transition-colors opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-text"
                  aria-label={revealLabel}
                  title={revealLabel}
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); api.remove.mutate(att.id); }}
                  className="p-1 rounded hover:bg-hover transition-colors opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-danger"
                  aria-label={t("tasks.removeFile")}
                  title={t("tasks.removeFile")}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      )}
      <button
        onClick={() => api.add.mutate()}
        disabled={api.add.isPending}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium text-accent hover:bg-accent/10 transition-colors disabled:opacity-50"
      >
        {api.add.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
        {t("tasks.addFiles")}
      </button>
    </div>
  );
}
