import { useState, useEffect } from "react";
import { Download, Upload, Settings2, HardDrive, Folder, Mail, Paperclip, ListChecks, KeyRound, AlertTriangle, CheckCircle, Loader2 } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { Button } from "../ui/Button";
import { createBackup, previewRestore, restoreBackup } from "../../lib/tauri";
import { validateBackupOptions, backupErrorText } from "../../lib/backupOptions";
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
    include_tasks: true,
    include_credentials: false,
  });
  const [passphrase, setPassphrase] = useState("");
  const [passphraseRepeat, setPassphraseRepeat] = useState("");
  const [backupProgress, setBackupProgress] = useState<BackupProgress | null>(null);
  const backupBusy = backupProgress !== null && backupProgress.status !== "done" && backupProgress.status !== "error";

  const [preview, setPreview] = useState<RestorePreview | null>(null);
  const [restorePassphrase, setRestorePassphrase] = useState("");
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

  // Only the boolean flags drive a checkbox; `passphrase` is a value, not a toggle.
  type BackupToggleKey = Exclude<keyof BackupOptions, "passphrase">;

  function toggleOption(key: BackupToggleKey) {
    setOptions((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      // Credentials can only be encrypted alongside the account records they belong to.
      if (key === "include_accounts" && !next.include_accounts) next.include_credentials = false;
      return next;
    });
    if (key === "include_accounts" || key === "include_credentials") {
      setPassphrase("");
      setPassphraseRepeat("");
    }
  }

  const validation = validateBackupOptions(options, passphrase, passphraseRepeat);

  async function handleCreateBackup() {
    try {
      await createBackup({
        ...options,
        passphrase: options.include_credentials ? passphrase : undefined,
      });
      setPassphrase("");
      setPassphraseRepeat("");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addToast("error", t("errors.backupCreate"), backupErrorText(message, t));
    }
  }

  async function handleSelectBackupFile() {
    try {
      const result = await previewRestore();
      setPreview(result);
      setRestorePassphrase("");
      setPasswordHintEmails([]);
    } catch (err) {
      addToast("error", t("errors.backupPreview"), err instanceof Error ? err.message : String(err));
    }
  }

  async function handleRestore(strategy: "merge" | "replace") {
    if (!preview) return;
    try {
      await restoreBackup(preview.file_path, strategy, preview.has_credentials ? restorePassphrase || undefined : undefined);
      setPreview(null);
      setRestorePassphrase("");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      addToast("error", t("errors.backupRestore"), backupErrorText(message, t));
    }
  }

  const anySelected = Object.values(options).some((v) => v === true);

  const BACKUP_ITEMS: { key: BackupToggleKey; icon: typeof Settings2; labelKey: string; hintKey?: string }[] = [
    { key: "include_settings", icon: Settings2, labelKey: "backup.appSettings" },
    { key: "include_accounts", icon: HardDrive, labelKey: "backup.accounts", hintKey: "backup.accountsHint" },
    { key: "include_folders", icon: Folder, labelKey: "backup.folders" },
    { key: "include_mails", icon: Mail, labelKey: "backup.emails" },
    { key: "include_attachments", icon: Paperclip, labelKey: "backup.attachments", hintKey: "backup.attachmentsHint" },
    { key: "include_tasks", icon: ListChecks, labelKey: "backup.includeTasks" },
    { key: "include_credentials", icon: KeyRound, labelKey: "backup.includeCredentials", hintKey: "backup.credentialsHint" },
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
          {BACKUP_ITEMS.map(({ key, icon: Icon, labelKey, hintKey }) => {
            const credentialsLocked = key === "include_credentials" && !options.include_accounts;
            return (
              <div key={key}>
                <label className="flex items-center gap-3 p-2 rounded-lg hover:bg-hover transition-colors cursor-pointer">
                  <input
                    type="checkbox"
                    checked={options[key] === true}
                    onChange={() => toggleOption(key)}
                    disabled={backupBusy || restoreBusy || credentialsLocked}
                    className="w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0 bg-bg-secondary"
                  />
                  <Icon className="w-4 h-4 text-text-tertiary" />
                  <span className="text-sm text-text">{t(labelKey)}</span>
                  {hintKey && <span className="text-xs text-text-tertiary">{t(hintKey)}</span>}
                </label>
                {key === "include_credentials" && options.include_credentials && (
                  <div className="ml-9 mr-2 mb-1 space-y-1.5">
                    <div>
                      <label htmlFor="backup-passphrase" className="block text-sm font-medium text-text-secondary mb-1">
                        {t("backup.passphrase")}
                      </label>
                      <input
                        id="backup-passphrase"
                        type="password"
                        autoComplete="new-password"
                        value={passphrase}
                        onChange={(e) => setPassphrase(e.target.value)}
                        disabled={backupBusy || restoreBusy}
                        className="w-full text-sm px-2 py-1.5 rounded-lg border border-border bg-bg-secondary text-text"
                      />
                    </div>
                    <div>
                      <label htmlFor="backup-passphrase-repeat" className="block text-sm font-medium text-text-secondary mb-1">
                        {t("backup.passphraseRepeat")}
                      </label>
                      <input
                        id="backup-passphrase-repeat"
                        type="password"
                        autoComplete="new-password"
                        value={passphraseRepeat}
                        onChange={(e) => setPassphraseRepeat(e.target.value)}
                        disabled={backupBusy || restoreBusy}
                        className="w-full text-sm px-2 py-1.5 rounded-lg border border-border bg-bg-secondary text-text"
                      />
                    </div>
                    {validation.reason === "tooShort" && (
                      <div className="text-xs text-danger">{t("backup.passphraseTooShort")}</div>
                    )}
                    {validation.reason === "mismatch" && (
                      <div className="text-xs text-danger">{t("backup.passphraseMismatch")}</div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
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
            <span className="truncate">{backupErrorText(backupProgress.message, t)}</span>
          </div>
        )}

        <Button
          variant="primary"
          size="sm"
          icon={<Download />}
          loading={backupBusy}
          disabled={!anySelected || restoreBusy || !validation.ok}
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
                <span className="truncate">{backupErrorText(restoreProgress.message, t)}</span>
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
              {preview.manifest.includes.tasks && (
                <div className="flex justify-between">
                  <span className="text-text-tertiary">{t("backup.tasksCount", { count: preview.manifest.stats.task_count })}</span>
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
                    preview.manifest.includes.tasks && t("backup.includeTasks"),
                    preview.manifest.includes.credentials && t("backup.includeCredentials"),
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

            {preview.manifest.includes.accounts && !preview.has_credentials && (
              <div className="flex items-start gap-2 p-2 rounded-lg bg-accent/5 text-xs text-text-secondary">
                <HardDrive className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{t("backup.passwordHint")}</span>
              </div>
            )}

            {preview.has_credentials && (
              <div className="space-y-1">
                <label htmlFor="backup-restore-passphrase" className="block text-sm font-medium text-text-secondary mb-1">
                  {t("backup.restorePassphrase")}
                </label>
                <input
                  id="backup-restore-passphrase"
                  type="password"
                  autoComplete="new-password"
                  value={restorePassphrase}
                  onChange={(e) => setRestorePassphrase(e.target.value)}
                  disabled={restoreBusy}
                  className="w-full text-sm px-2 py-1.5 rounded-lg border border-border bg-bg-secondary text-text"
                />
                <div className="text-xs text-text-tertiary">{t("backup.restoreWithoutCredentials")}</div>
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
                onClick={() => {
                  setPreview(null);
                  setRestorePassphrase("");
                }}
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
