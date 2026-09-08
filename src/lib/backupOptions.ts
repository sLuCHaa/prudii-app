import type { BackupOptions } from "../types";
import i18n from "./i18n";

export interface ValidateBackupOptionsResult {
  ok: boolean;
  reason?: "tooShort" | "mismatch" | "needsAccounts";
}

/**
 * Pure gate for the "Account credentials" backup option: no passphrase is
 * required unless credentials are actually being encrypted into the archive.
 */
export function validateBackupOptions(
  options: BackupOptions,
  passphrase: string,
  repeat: string,
): ValidateBackupOptionsResult {
  if (!options.include_credentials) return { ok: true };
  if (!options.include_accounts) return { ok: false, reason: "needsAccounts" };
  // Count code points, not UTF-16 units — the Rust guard uses `chars().count()`,
  // so astral characters must not pass here and be rejected by the backend.
  if ([...passphrase].length < 8) return { ok: false, reason: "tooShort" };
  if (passphrase !== repeat) return { ok: false, reason: "mismatch" };
  return { ok: true };
}

/**
 * Mirrors the backend guard in `create_backup`: credentials ride along with the
 * accounts, they are not a category of their own.
 */
export function hasBackupCategory(options: BackupOptions): boolean {
  return (
    options.include_settings ||
    options.include_accounts ||
    options.include_folders ||
    options.include_mails ||
    options.include_attachments ||
    options.include_tasks === true
  );
}

/**
 * Backend progress/error events carry either a bare `backup.*` i18n key or a
 * plain diagnostic string; only the former should ever be translated.
 */
export function backupErrorText(message: string, t: (key: string) => string): string {
  if (message.startsWith("backup.") && i18n.exists(message)) return t(message);
  return message;
}
