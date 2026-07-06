import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { Download, CheckCircle, XCircle, RefreshCw, Loader2, ShieldAlert } from "lucide-react";
import { Button } from "../ui/Button";
import { checkForUpdate, installUpdate, type Update } from "../../lib/updater";

type UpdateStatus = "idle" | "checking" | "update-available" | "up-to-date" | "downloading" | "verifying" | "ready" | "error";

export function UpdatePanel() {
  const { t } = useTranslation();
  const [currentVersion, setCurrentVersion] = useState("");
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [release, setRelease] = useState<Update | null>(null);
  const [progressPct, setProgressPct] = useState(0);
  const [errorKind, setErrorKind] = useState<"check" | "install" | null>(null);

  useEffect(() => {
    getVersion().then(setCurrentVersion).catch(() => setCurrentVersion("?"));
  }, []);

  async function handleCheck() {
    setStatus("checking");
    setErrorKind(null);
    try {
      const info = await checkForUpdate();
      if (info) {
        setRelease(info);
        setStatus("update-available");
      } else {
        setStatus("up-to-date");
      }
    } catch {
      setStatus("error");
      setErrorKind("check");
    }
  }

  async function handleDownload() {
    if (!release) return;
    setStatus("downloading");
    setProgressPct(0);
    setErrorKind(null);
    try {
      await installUpdate(release, (p) => {
        if (p.phase === "downloading") { setStatus("downloading"); setProgressPct(p.pct); }
        else if (p.phase === "verifying") setStatus("verifying");
        else if (p.phase === "ready") setStatus("ready");
      });
    } catch {
      setStatus("error");
      setErrorKind("install");
    }
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-text mb-1">{t("settings.update.title")}</h3>
      <p className="text-xs text-text-tertiary mb-4">{t("settings.update.currentVersion")}: <span className="font-mono">{currentVersion}</span></p>

      {(status === "idle" || status === "up-to-date" || status === "error") && (
        <div className="space-y-3">
          <Button
            variant="secondary"
            size="sm"
            icon={<RefreshCw />}
            onClick={handleCheck}
          >
            {t("settings.update.checkButton")}
          </Button>

          {status === "up-to-date" && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-border bg-bg-secondary">
              <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
              <span className="text-sm text-text">{t("settings.update.upToDate")}</span>
            </div>
          )}

          {status === "error" && errorKind === "install" && (
            <div className="p-4 rounded-lg border border-danger/30 bg-danger/5">
              <div className="flex items-start gap-3">
                <ShieldAlert className="w-5 h-5 text-danger shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-danger">{t("settings.update.checksumError")}</p>
                </div>
              </div>
            </div>
          )}

          {status === "error" && errorKind !== "install" && (
            <div className="flex items-center gap-2 p-3 rounded-lg border border-danger/30 bg-danger/5">
              <XCircle className="w-4 h-4 text-danger shrink-0" />
              <span className="text-sm text-danger">{t("settings.update.networkError")}</span>
            </div>
          )}
        </div>
      )}

      {status === "checking" && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-border">
          <Loader2 className="w-4 h-4 text-accent animate-spin" />
          <span className="text-sm text-text-secondary">{t("settings.update.checking")}</span>
        </div>
      )}

      {status === "update-available" && release && (
        <div className="space-y-3">
          <div className="p-3 rounded-lg border border-accent/30 bg-accent-soft">
            <p className="text-sm font-medium text-text">
              {t("settings.update.available", { version: release.version })}
            </p>
          </div>
          <Button
            variant="primary"
            size="sm"
            icon={<Download />}
            onClick={handleDownload}
          >
            {t("settings.update.downloadButton")}
          </Button>
        </div>
      )}

      {status === "downloading" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Loader2 className="w-4 h-4 text-accent animate-spin" />
            <span className="text-sm text-text-secondary">{t("settings.update.downloading")}</span>
            <span className="text-xs text-text-tertiary ml-auto">{progressPct}%</span>
          </div>
          <div className="w-full h-2 rounded-full bg-bg-secondary overflow-hidden">
            <div
              className="h-full rounded-full bg-accent transition-all duration-300"
              style={{ width: `${progressPct}%` }}
            />
          </div>
        </div>
      )}

      {status === "verifying" && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-border">
          <Loader2 className="w-4 h-4 text-accent animate-spin" />
          <span className="text-sm text-text-secondary">{t("settings.update.verifying")}</span>
        </div>
      )}

      {/* Ready — launching installer */}
      {status === "ready" && (
        <div className="flex items-center gap-2 p-3 rounded-lg border border-green-500/30 bg-green-500/5">
          <CheckCircle className="w-4 h-4 text-green-500 shrink-0" />
          <span className="text-sm text-text">{t("settings.update.verified")}</span>
        </div>
      )}
    </div>
  );
}
