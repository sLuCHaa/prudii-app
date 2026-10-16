import { useState } from "react";
import { ArrowUp, Check, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { installUpdate } from "../../lib/updater";
import { bannerView, type UpdatePhase } from "../../lib/updateBanner";
import { Button } from "./Button";

const TONE_TILE = {
  accent: "bg-accent text-white",
  success: "bg-success text-white",
  danger: "bg-danger text-white",
} as const;

/**
 * Shown when `checkForUpdate` found a newer release. "Later" hides it for this
 * session; it returns on the next launch while the update is still pending.
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<UpdatePhase>("idle");
  const [progressPct, setProgressPct] = useState(0);

  if (!updateAvailable || dismissed) return null;

  async function handleUpdate() {
    if (!updateAvailable) return;
    setPhase("downloading");
    setProgressPct(0);
    try {
      await installUpdate(updateAvailable, (p) => {
        if (p.phase === "downloading") { setPhase("downloading"); setProgressPct(p.pct); }
        else if (p.phase === "verifying") setPhase("verifying");
        else if (p.phase === "ready") setPhase("ready");
      });
    } catch {
      setPhase("error");
    }
  }

  const view = bannerView(phase, progressPct);
  const Icon = view.tone === "danger" ? ShieldAlert : view.tone === "success" ? Check : ArrowUp;

  return (
    <div
      role="status"
      className="relative shrink-0 flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-1.5 bg-surface border-b border-border"
      style={{ backgroundImage: "linear-gradient(90deg, var(--color-accent-soft), transparent 70%)" }}
    >
      <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-md ${TONE_TILE[view.tone]}`}>
        <Icon className="h-3.5 w-3.5" strokeWidth={2.4} />
      </span>

      <div className="flex min-w-0 flex-1 items-baseline gap-2">
        <span
          title={t(view.titleKey, { pct: view.pct ?? 0 })}
          className={`truncate text-[13px] font-semibold ${view.tone === "danger" ? "text-danger" : "text-text"}`}
        >
          {t(view.titleKey, { pct: view.pct ?? 0 })}
        </span>
        {view.showDetails && (
          <>
            <span className="shrink-0 rounded-full bg-accent-soft px-2 text-[11px] font-bold tabular-nums text-accent">
              {updateAvailable.version}
            </span>
            <span className="hidden truncate text-xs text-text-secondary md:inline">{t("updateBanner.subtitle")}</span>
          </>
        )}
      </div>

      {view.actions !== "none" && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <Button variant="ghost" size="sm" onClick={() => setDismissed(true)}>
            {t("updateBanner.later")}
          </Button>
          <Button variant="primary" size="sm" onClick={handleUpdate}>
            {t(view.actions === "retry" ? "updateBanner.retry" : "updateBanner.install")}
          </Button>
        </div>
      )}

      {view.pct !== null && (
        <span
          aria-hidden="true"
          className="absolute -bottom-px left-0 h-0.5 bg-accent transition-[width] duration-200 ease-linear motion-reduce:transition-none"
          style={{ width: `${view.pct}%` }}
        />
      )}
    </div>
  );
}
