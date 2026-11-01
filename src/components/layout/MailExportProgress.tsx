import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { cancelMailExport } from "../../lib/tauri";

export function MailExportProgress() {
  const { t } = useTranslation();
  const { running, progress } = useAppStore((s) => s.mailExport);
  if (!running) return null;

  const processed = progress?.processed ?? 0;
  const total = progress?.total ?? 0;
  const percent = total > 0 ? (processed / total) * 100 : 0;

  return (
    <div className="mb-3">
      <p className="text-xs text-text-secondary truncate mb-1.5">
        {t("mailExport.progress", { processed, total })}
      </p>
      <div className="relative h-1.5 rounded-full bg-border overflow-hidden">
        <div
          className="absolute h-full bg-linear-to-r from-accent to-purple-500 rounded-full"
          style={{ width: `${percent}%`, transition: "width 0.5s ease-out" }}
        />
      </div>
      <button
        type="button"
        onClick={() => { void cancelMailExport(); }}
        className="mt-1.5 text-xs text-text-tertiary hover:text-text transition-colors"
      >
        {t("mailExport.cancel")}
      </button>
    </div>
  );
}
