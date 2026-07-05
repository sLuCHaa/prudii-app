import { useState, useEffect } from "react";
import { Download, Upload, Settings2, HardDrive, Folder, Mail, Paperclip, AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "../ui/Button";
import { createBackup, previewRestore, restoreBackup } from "../../lib/tauri";
import type { BackupOptions, BackupProgress, RestorePreview } from "../../types";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";

export function BackupRestore() {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const [options, setOptions] = useState<BackupOptions>({
    include_settings: true,
    include_accounts: true,
    include_folders: true,
    include_mails: true,
    include_attachments: false,
  });
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const backupBusy = backupProgress !== null && backupProgress.status !== "done" && backupProgress.status !== "error";

  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [restoreProgress, setRestoreProgress] = useState<BackupProgress | null>(null);
  const restoreBusy = restoreProgress !== null && restoreProgress.status !== "done" && restoreProgress.status !== "error";
  const [passwordHintEmails, setPasswordHintEmails] = useState<string[]>([]);

  useEffect(() => {
    const unlistenBackup = listen<BackupProgress>("backup-progress", (event) => {
      setBackupProgress(event.payload);
      if (event.payload.status === "done" || event.payload.status === "error") {
        setTimeout(() => setBackupProgress(null), 4000);
      }
    });
    const unlistenRestore = listen<BackupProgress>("restore-progress", (event) => {
      setRestoreProgress(event.payload);
      if (event.payload.status === "done" || event.payload.status === "error") {
        setTimeout(() => setRestoreProgress(null), 4000);
      }
    });
    const unlistenPasswords = listen<{ emails: string[] }>("restore-needs-passwords", (event) => {
      setPasswordHintEmails(event.payload.emails);
    });

    return () => {
      unlistenBackup.then((fn) => fn());
      unlistenRestore.then((fn) => fn());
      unlistenPasswords.then((fn) => fn());
    };
  }, []);

  function toggleOption(key: keyof BackupOptions) {
    setOptions((prev) => ({ ...prev, [key]: !prev[key] }));
  }

  async function handleCreateBackup() {
    try {
      await createBackup(options);
    } catch (err) {
      addToast("error", t("errors.backupCreate"), err instanceof Error ? err.message : String(err));
    }
  }

  async function handleSelectBackupFile() {
    try {
      const result = await previewRestore();
      setPreview(result);
      setPasswordHintEmails([]);
    } catch (err) {
      addToast("error", t("errors.backupPreview"), err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRestore(strategy: "merge" | "replace") {
    if (!preview) return;
    try {
      await restoreBackup(preview.file_path, strategy);
      setPreview(null);
    } catch (err) {
      addToast("error", t("errors.backupRestore"), err instanceof Error ? err.message : String(err));
    }
  }

  const anySelected = Object.values(options).some((v) => v);

  const BACKUP_ITEMS: { key: keyof BackupOptions; icon: typeof Settings2; labelKey: string; hintKey?: string }[] = [
    { key: "include_settings", icon: Settings2, labelKey: "backup.appSettings" },
    { key: "include_accounts", icon: HardDrive, labelKey: "backup.accounts", hintKey: "backup.accountsHint" },
    { key: "include_folders", icon: Folder, labelKey: "backup.folders" },
    { key: "include_mails", icon: Mail, labelKey: "backup.emails" },
    { key: "include_attachments", icon: Paperclip, labelKey: "backup.attachments", hintKey: "backup.attachmentsHint" },
  ];

  return (
    <div>
      <h3 className="text-sm font-medium text-text mb-1">{t("backup.title")}</h3>
      <p className="text-xs text-text-tertiary mb-3">
        {t("backup.description")}
      </p>

      <div className="p-3 rounded-lg border border-border space-y-3">
        <div className="flex items-center gap-2">
          <Download className="w-4 h-4 text-text-tertiary" />
          <span className="text-sm font-medium text-text">{t("backup.createBackup")}</span>
        </div>

        <div className="space-y-1.5">
          {BACKUP_ITEMS.map(({ key, icon: Icon, labelKey, hintKey }) => (
            <label
              key={key}
              className="flex items-center gap-3 p-2 rounded-lg hover:bg-hover transition-colors cursor-pointer"
            >
              <input
                type="checkbox"
                checked={options[key]}
                onChange={() => toggleOption(key)}
                disabled={backupBusy || restoreBusy}
                className="w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0 bg-bg-secondary"
              />
              <Icon className="w-4 h-4 text-text-tertiary" />
              <span className="text-sm text-text">{t(labelKey)}</span>
              {hintKey && <span className="text-xs text-text-tertiary">{t(hintKey)}</span>}
            </label>
          ))}
        </div>

        {backupProgress && (
          <div className={`flex items-center gap-2 p-2 rounded-lg text-xs ${
            backupProgress.status === "error" ? "bg-danger/10 text-danger" :
            backupProgress.status === "done" ? "bg-success/10 text-success" :
            "bg-accent/10 text-accent"
          }`}>
            {backupProgress.status === "done" ? (
              <CheckCircle className="w-3.5 h-3.5 shrink-0" />
            ) : backupProgress.status === "error" ? (
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            ) : (
              <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
            )}
            <span className="truncate">{backupProgress.message}</span>
          </div>
        )}

        <Button
          variant="primary"
          size="sm"
          icon={<Download />}
          loading={backupBusy}
          disabled={!anySelected || restoreBusy}
          onClick={handleCreateBackup}
        >
          {t("backup.createBackup")}
        </Button>
      </div>

      <div className="p-3 rounded-lg border border-border space-y-3 mt-3">
        <div className="flex items-center gap-2">
          <Upload className="w-4 h-4 text-text-tertiary" />
          <span className="text-sm font-medium text-text">{t("backup.restoreTitle")}</span>
        </div>

        {!preview ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              icon={<Upload />}
              disabled={backupBusy || restoreBusy}
              onClick={handleSelectBackupFile}
            >
              {t("backup.selectFile")}
            </Button>

            {restoreProgress && (
              <div className={`flex items-center gap-2 p-2 rounded-lg text-xs ${
                restoreProgress.status === "error" ? "bg-danger/10 text-danger" :
                restoreProgress.status === "done" ? "bg-success/10 text-success" :
                "bg-accent/10 text-accent"
              }`}>
                {restoreProgress.status === "done" ? (
                  <CheckCircle className="w-3.5 h-3.5 shrink-0" />
                ) : restoreProgress.status === "error" ? (
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
                ) : (
                  <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
                )}
                <span className="truncate">{restoreProgress.message}</span>
              </div>
            )}

            {passwordHintEmails.length > 0 && (
              <div className="flex items-start gap-2 p-2 rounded-lg bg-yellow-500/10 text-xs text-yellow-600 dark:text-yellow-400">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">{t("backup.passwordsNeeded")}</div>
                  <div className="mt-0.5">
                    {t("backup.passwordsNeededDesc")}
                    {passwordHintEmails.map((email) => (
                      <div key={email} className="font-mono mt-0.5">{email}</div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="space-y-3">
            <div className="p-2 rounded-lg bg-bg-secondary text-xs space-y-1">
              <div className="flex justify-between">
                <span className="text-text-tertiary">{t("backup.created")}</span>
                <span className="text-text">{preview.manifest.created_at}</span>
              </div>
              {preview.manifest.includes.accounts && (
                <div className="flex justify-between">
                  <span className="text-text-tertiary">{t("backup.accounts")}</span>
                  <span className="text-text">{preview.manifest.stats.account_count}</span>
                </div>
              )}
              {preview.manifest.includes.folders && (
                <div className="flex justify-between">
                  <span className="text-text-tertiary">{t("backup.folders")}</span>
                  <span className="text-text">{preview.manifest.stats.folder_count}</span>
                </div>
              )}
              {preview.manifest.includes.mails && (
                <div className="flex justify-between">
                  <span className="text-text-tertiary">{t("backup.emails")}</span>
                  <span className="text-text">{preview.manifest.stats.mail_count.toLocaleString()}</span>
                </div>
              )}
              {preview.manifest.includes.attachments && (
                <div className="flex justify-between">
                  <span className="text-text-tertiary">{t("backup.attachments")}</span>
                  <span className="text-text">{preview.manifest.stats.attachment_count}</span>
                </div>
              )}
              <div className="flex justify-between">
                <span className="text-text-tertiary">{t("backup.includes")}</span>
                <span className="text-text">
                  {[
                    preview.manifest.includes.app_settings && t("backup.appSettings"),
                    preview.manifest.includes.accounts && t("backup.accounts"),
                    preview.manifest.includes.folders && t("backup.folders"),
                    preview.manifest.includes.mails && t("backup.emails"),
                    preview.manifest.includes.attachments && t("backup.attachments"),
                  ].filter(Boolean).join(", ")}
                </span>
              </div>
            </div>

            {preview.existing_account_emails.length > 0 && (
              <div className="flex items-start gap-2 p-2 rounded-lg bg-yellow-500/10 text-xs text-yellow-600 dark:text-yellow-400">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <div>
                  <div className="font-medium">{t("backup.existingAccounts")}</div>
                  <div className="mt-0.5">
                    {preview.existing_account_emails.map((email) => (
                      <div key={email} className="font-mono">{email}</div>
                    ))}
                  </div>
                  <div className="mt-1 text-text-tertiary">
                    {t("backup.mergeHint")}
                  </div>
                </div>
              </div>
            )}

            {preview.manifest.includes.accounts && (
              <div className="flex items-start gap-2 p-2 rounded-lg bg-accent/5 text-xs text-text-secondary">
                <HardDrive className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{t("backup.passwordHint")}</span>
              </div>
            )}

            <div className="flex gap-2">
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleRestore("merge")}
                disabled={restoreBusy}
              >
                {t("common.merge")}
              </Button>
              {preview.existing_account_emails.length > 0 && (
                <Button
                  variant="danger"
                  size="sm"
                  onClick={() => handleRestore("replace")}
                  disabled={restoreBusy}
                >
                  {t("common.replace")}
                </Button>
              )}
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPreview(null)}
                disabled={restoreBusy}
              >
                {t("common.cancel")}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
