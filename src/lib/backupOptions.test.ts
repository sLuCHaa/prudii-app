import { describe, it, expect } from "vitest";
import { validateBackupOptions, backupErrorText, hasBackupCategory } from "./backupOptions";
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

  it("counts astral characters as one each, like the Rust guard", () => {
    const options = { ...baseOptions, include_credentials: true };
    const sevenEmoji = "😀😁😂😃😄😅😆";
    expect(sevenEmoji.length).toBe(14);
    expect(validateBackupOptions(options, sevenEmoji, sevenEmoji)).toEqual({ ok: false, reason: "tooShort" });
    const eightEmoji = sevenEmoji + "😇";
    expect(validateBackupOptions(options, eightEmoji, eightEmoji)).toEqual({ ok: true });
  });

  it("accepts a matching passphrase of sufficient length", () => {
    const options = { ...baseOptions, include_credentials: true };
    expect(validateBackupOptions(options, "longenough", "longenough")).toEqual({ ok: true });
  });
});

describe("hasBackupCategory", () => {
  const nothing: BackupOptions = {
    include_settings: false,
    include_accounts: false,
    include_folders: false,
    include_mails: false,
    include_attachments: false,
    include_tasks: false,
    include_credentials: false,
  };

  it("accepts a tasks-only backup", () => {
    expect(hasBackupCategory({ ...nothing, include_tasks: true })).toBe(true);
  });

  it("rejects an empty selection", () => {
    expect(hasBackupCategory(nothing)).toBe(false);
  });

  it("does not count credentials as a category of their own", () => {
    expect(hasBackupCategory({ ...nothing, include_credentials: true })).toBe(false);
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
