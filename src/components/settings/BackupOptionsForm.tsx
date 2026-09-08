import { Settings2, HardDrive, Folder, Mail, Paperclip, ListChecks, KeyRound } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BackupOptions } from "../../types";
import type { ValidateBackupOptionsResult } from "../../lib/backupOptions";

// Only the boolean flags drive a checkbox; `passphrase` is a value, not a toggle.
type BackupToggleKey = Exclude<keyof BackupOptions, "passphrase">;

const BACKUP_ITEMS: { key: BackupToggleKey; icon: typeof Settings2; labelKey: string; hintKey?: string }[] = [
  { key: "include_settings", icon: Settings2, labelKey: "backup.appSettings" },
  { key: "include_accounts", icon: HardDrive, labelKey: "backup.accounts", hintKey: "backup.accountsHint" },
  { key: "include_folders", icon: Folder, labelKey: "backup.folders" },
  { key: "include_mails", icon: Mail, labelKey: "backup.emails" },
  { key: "include_attachments", icon: Paperclip, labelKey: "backup.attachments", hintKey: "backup.attachmentsHint" },
  { key: "include_tasks", icon: ListChecks, labelKey: "backup.includeTasks" },
  { key: "include_credentials", icon: KeyRound, labelKey: "backup.includeCredentials", hintKey: "backup.credentialsHint" },
];

interface BackupOptionsFormProps {
  options: BackupOptions;
  onChange: (options: BackupOptions) => void;
  passphrase: string;
  repeat: string;
  onPassphraseChange: (passphrase: string, repeat: string) => void;
  validation: ValidateBackupOptionsResult;
  disabled?: boolean;
}

export function BackupOptionsForm({
  options,
  onChange,
  passphrase,
  repeat,
  onPassphraseChange,
  validation,
  disabled = false,
}: BackupOptionsFormProps) {
  const { t } = useTranslation();

  function toggleOption(key: BackupToggleKey) {
    const next = { ...options, [key]: !options[key] };
    // Credentials can only be encrypted alongside the account records they belong to.
    if (key === "include_accounts" && !next.include_accounts) next.include_credentials = false;
    onChange(next);
    if (key === "include_accounts" || key === "include_credentials") onPassphraseChange("", "");
  }

  return (
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
                disabled={disabled || credentialsLocked}
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
                    onChange={(e) => onPassphraseChange(e.target.value, repeat)}
                    disabled={disabled}
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
                    value={repeat}
                    onChange={(e) => onPassphraseChange(passphrase, e.target.value)}
                    disabled={disabled}
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
  );
}
