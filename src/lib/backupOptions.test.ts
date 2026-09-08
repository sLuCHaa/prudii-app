import { describe, it, expect } from "vitest";
import { validateBackupOptions, backupErrorText } from "./backupOptions";
import type { BackupOptions } from "../types";

const baseOptions: BackupOptions = {
  include_settings: true,
  include_accounts: true,
  include_folders: true,
  include_mails: true,
  include_attachments: false,
  include_tasks: true,
  include_credentials: false,
};

describe("validateBackupOptions", () => {
  it("is always valid when credentials are not selected", () => {
    expect(validateBackupOptions({ ...baseOptions, include_credentials: false }, "", "")).toEqual({ ok: true });
  });

  it("requires accounts to be included alongside credentials", () => {
    const options = { ...baseOptions, include_accounts: false, include_credentials: true };
    expect(validateBackupOptions(options, "longenough", "longenough")).toEqual({ ok: false, reason: "needsAccounts" });
  });

  it("rejects a passphrase shorter than 8 characters", () => {
    const options = { ...baseOptions, include_credentials: true };
    expect(validateBackupOptions(options, "short", "short")).toEqual({ ok: false, reason: "tooShort" });
  });

  it("rejects mismatched passphrase and repeat", () => {
    const options = { ...baseOptions, include_credentials: true };
    expect(validateBackupOptions(options, "longenough", "different")).toEqual({ ok: false, reason: "mismatch" });
  });

  it("accepts a matching passphrase of sufficient length", () => {
    const options = { ...baseOptions, include_credentials: true };
    expect(validateBackupOptions(options, "longenough", "longenough")).toEqual({ ok: true });
  });
});

describe("backupErrorText", () => {
  it("translates a known bare backup.* key", () => {
    const t = (key: string) => (key === "backup.wrongPassphrase" ? "Wrong passphrase or damaged backup" : key);
    expect(backupErrorText("backup.wrongPassphrase", t)).toBe("Wrong passphrase or damaged backup");
  });

  it("passes through a raw diagnostic message unchanged", () => {
    const t = (key: string) => key;
    expect(backupErrorText("IO error: permission denied", t)).toBe("IO error: permission denied");
  });
});
