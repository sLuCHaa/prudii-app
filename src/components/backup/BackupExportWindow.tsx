import { useEffect, useState } from "react";
import { Download, AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { Button } from "../ui/Button";
import { BackupOptionsForm } from "../settings/BackupOptionsForm";
import { createBackup, getAppSettings, getSystemAccentColor } from "../../lib/tauri";
import { validateBackupOptions, backupErrorText, hasBackupCategory } from "../../lib/backupOptions";
import { isAccentHex, DEFAULT_ACCENT_HEX } from "../../lib/accents";
import type { BackupOptions, BackupProgress } from "../../types";

function storedDarkMode(): boolean {
  const mode = localStorage.getItem("prudii-theme-mode") || "system";
  if (mode === "system") return window.matchMedia("(prefers-color-scheme: dark)").matches;
  return mode === "dark";
}

export function BackupExportWindow() {
  const { t } = useTranslation();
  const [options, setOptions] = useState<BackupOptions>({
    include_settings: true,
    include_accounts: true,
    include_folders: true,
    include_mails: true,
    include_attachments: false,
    include_tasks: true,
    include_credentials: false,
  });
  const [passphrase, setPassphrase] = useState("");
  const [passphraseRepeat, setPassphraseRepeat] = useState("");
  const [progress, setProgress] = useState<BackupProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = progress !== null && progress.status !== "done" && progress.status !== "error";
  const done = progress?.status === "done";

  // This window has no store and no settings bootstrap of its own — theme and
  // accent are read straight from localStorage/DB so it matches the main app.
  useEffect(() => {
    document.documentElement.classList.toggle("dark", storedDarkMode());
    getAppSettings()
      .then((s) => {
        if (s.theme_mode === "light" || s.theme_mode === "dark") {
          document.documentElement.classList.toggle("dark", s.theme_mode === "dark");
        }
        document.documentElement.setAttribute("data-accent", s.accent_color);
        document.documentElement.setAttribute("data-density", s.density);
        document.documentElement.toggleAttribute("data-system-font", s.use_system_font);
        if (s.accent_color === "system") {
          getSystemAccentColor()
            .then((hex) => document.documentElement.style.setProperty("--c-accent-system", isAccentHex(hex) ? hex : DEFAULT_ACCENT_HEX))
            .catch(() => document.documentElement.style.setProperty("--c-accent-system", DEFAULT_ACCENT_HEX));
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unlisten = listen<BackupProgress>("backup-progress", (event) => {
      setProgress(event.payload);
      if (event.payload.status !== "error") setError(null);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const validation = validateBackupOptions(options, passphrase, passphraseRepeat);
  const anySelected = hasBackupCategory(options);

  async function handleCreateBackup() {
    setError(null);
    try {
      await createBackup({
        ...options,
        passphrase: options.include_credentials ? passphrase : undefined,
      });
      setPassphrase("");
      setPassphraseRepeat("");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(backupErrorText(message, t));
      setProgress(null);
    }
  }

  function closeWindow() {
    getCurrentWindow().close().catch(() => {});
  }

  return (
    <div className="h-screen flex flex-col bg-bg text-text">
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        <div>
          <h1 className="text-base font-medium text-text">{t("backup.exportTitle")}</h1>
          <p className="text-xs text-text-tertiary mt-1">{t("backup.exportIntro")}</p>
        </div>

        {done ? (
          <div className="flex items-start gap-2 p-3 rounded-lg border border-border bg-success/10 text-success text-sm">
            <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{t("backup.exportDone")}</span>
          </div>
        ) : (
          <div className="p-3 rounded-lg border border-border space-y-3">
            <BackupOptionsForm
              options={options}
              onChange={setOptions}
              passphrase={passphrase}
              repeat={passphraseRepeat}
              onPassphraseChange={(p, r) => {
                setPassphrase(p);
                setPassphraseRepeat(r);
              }}
              validation={validation}
              disabled={busy}
            />

            {(progress || error) && (
              <div className={`flex items-center gap-2 p-2 rounded-lg text-xs ${
                error || progress?.status === "error" ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent"
              }`}>
                {error || progress?.status === "error" ? (
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
                )}
                <span className="truncate">{error ?? backupErrorText(progress?.message ?? "", t)}</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center justify-end gap-2 p-4 border-t border-border">
        {done ? (
          <Button variant="primary" size="md" onClick={closeWindow}>
            {t("common.close")}
          </Button>
        ) : (
          <>
            <Button variant="secondary" size="md" disabled={busy} onClick={closeWindow}>
              {t("backup.exportSkip")}
            </Button>
            <Button
              variant="primary"
              size="md"
              icon={<Download />}
              loading={busy}
              disabled={!anySelected || !validation.ok}
              onClick={handleCreateBackup}
            >
              {t("backup.createBackup")}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
