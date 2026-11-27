import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { testPop3Connection, updateAccountSettings } from "./tauri";

beforeEach(() => {
  invoke.mockReset();
  invoke.mockResolvedValue({ message_count: 3, supports_uidl: true });
});

describe("POP3 IPC", () => {
  it("tests the connection with the backend argument names", async () => {
    const password = crypto.randomUUID();
    const result = await testPop3Connection("pop.studio-halde.example", 995, "ssl", "anna@studio-halde.example", password);
    expect(invoke).toHaveBeenCalledWith("test_pop3_connection", {
      host: "pop.studio-halde.example",
      port: 995,
      security: "ssl",
      email: "anna@studio-halde.example",
      password,
    });
    expect(result).toEqual({ message_count: 3, supports_uidl: true });
  });

  it("passes the incoming settings along", async () => {
    const incoming = { pop3_delete_mode: "after_days" as const, pop3_delete_after_days: 14 };
    await updateAccountSettings(
      "a1", "Anna Weber", "#3b82f6", "pop.studio-halde.example", 995,
      "smtp.studio-halde.example", 465, "ssl", "always", incoming,
    );
    expect(invoke).toHaveBeenCalledWith("update_account_settings", {
      accountId: "a1",
      displayName: "Anna Weber",
      color: "#3b82f6",
      imapHost: "pop.studio-halde.example",
      imapPort: 995,
      smtpHost: "smtp.studio-halde.example",
      smtpPort: 465,
      smtpSecurity: "ssl",
      loadExternalImages: "always",
      incoming,
    });
  });
});
