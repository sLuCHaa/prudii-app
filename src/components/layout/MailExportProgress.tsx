import { useTranslation } from "react-i18next";
import { Download } from "../icons";
import { useAppStore } from "../../stores/appStore";
import { cancelMailExport } from "../../lib/tauri";
import { GlowRing } from "../motion/GlowRing";

export function MailExportProgress({ compact = false, className = "" }: { compact?: boolean; className?: string }) {
  const { t, i18n } = useTranslation();
  const { running, progress } = useAppStore((s) => s.mailExport);
  if (!running) return null;

  const processed = progress?.processed ?? 0;
  const total = progress?.total ?? 0;
  const percent = total > 0 ? Math.min(100, (processed / total) * 100) : 0;
  const label = t("mailExport.progress", { processed, total });
  const bar = {
    role: "progressbar",
    "aria-label": label,
    "aria-valuemin": 0,
    "aria-valuemax": 100,
    "aria-valuenow": Math.round(percent),
  } as const;

  if (compact) {
    return (
      <div {...bar} title={label} className={className}>
        <GlowRing progress={percent / 100} size={26} strokeWidth={2.5}>
          <Download className="w-3 h-3 text-text-secondary" />
        </GlowRing>
      </div>
    );
  }

  return (
    <div className={className}>
      <div className="flex items-baseline justify-between gap-2 mb-1.5">
        <p className="text-xs text-text-secondary truncate">{label}</p>
        <span className="text-xs text-text-tertiary tabular-nums shrink-0">
          {new Intl.NumberFormat(i18n.language, { style: "percent", maximumFractionDigits: 0 }).format(Math.floor(percent) / 100)}
        </span>
      </div>
      <div {...bar} className="relative h-1.5 rounded-full bg-border overflow-hidden">
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
