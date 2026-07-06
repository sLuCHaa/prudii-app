import { useState } from "react";
import { ArrowUpCircle, Download, X, Loader2, CheckCircle, ShieldAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { installUpdate } from "../../lib/updater";
import { Button } from "./Button";

type Phase = "idle" | "downloading" | "verifying" | "ready" | "error";

/**
 * Non-blocking top banner shown when `checkForUpdate` found a newer release
 * (stored in `updateAvailable`). Lets the user download & install in place, or
 * dismiss for the session — it reappears on the next launch while still pending.
 */
export function UpdateBanner() {
  const { t } = useTranslation();
  const updateAvailable = useAppStore((s) => s.updateAvailable);
  const [dismissed, setDismissed] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progressPct, setProgressPct] = useState(0);
  const [errorMessage, setErrorMessage] = useState("");

  if (!updateAvailable || dismissed) return null;

  async function handleUpdate() {
    if (!updateAvailable) return;
    setPhase("downloading");
    setProgressPct(0);
    setErrorMessage("");
    try {
      await installUpdate(updateAvailable, (p) => {
        if (p.phase === "downloading") { setPhase("downloading"); setProgressPct(p.pct); }
        else if (p.phase === "verifying") setPhase("verifying");
        else if (p.phase === "ready") setPhase("ready");
      });
    } catch (err) {
      setPhase("error");
      setErrorMessage(err instanceof Error ? err.message : String(err));
    }
  }

  const busy = phase === "downloading" || phase === "verifying" || phase === "ready";

  return (
    <div className="shrink-0 flex items-center gap-3 px-4 py-2 bg-accent-soft border-b border-accent/30">
      {phase === "error" ? (
        <ShieldAlert className="w-4 h-4 text-danger shrink-0" />
      ) : phase === "ready" ? (
        <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
      ) : busy ? (
        <Loader2 className="w-4 h-4 text-accent shrink-0 animate-spin" />
      ) : (
        <ArrowUpCircle className="w-4 h-4 text-accent shrink-0" />
      )}

      <span className="text-sm text-text truncate">
        {phase === "downloading" && `${t("settings.update.downloading")} ${progressPct}%`}
        {phase === "verifying" && t("settings.update.verifying")}
        {phase === "ready" && t("settings.update.verified")}
        {phase === "error" && (errorMessage.includes("Checksum")
          ? t("settings.update.checksumError")
          : errorMessage.includes("Network") || errorMessage.includes("fetch")
            ? t("settings.update.networkError")
            : errorMessage)}
        {phase === "idle" && t("settings.update.available", { version: updateAvailable.version })}
      </span>

      <div className="flex items-center gap-2 ml-auto shrink-0">
        {(phase === "idle" || phase === "error") && (
          <Button variant="primary" size="sm" icon={<Download />} onClick={handleUpdate}>
            {t("settings.update.downloadButton")}
          </Button>
        )}
        {!busy && (
          <button
            onClick={() => setDismissed(true)}
            aria-label={t("common.close", { defaultValue: "Close" })}
            className="p-1 rounded hover:bg-hover text-text-tertiary"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  );
}
