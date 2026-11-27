import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import i18n from "./i18n";
import type { Account } from "../types";

const count = vi.hoisted(() => vi.fn());

vi.mock("./tauri", async (original) => ({
  ...(await original<typeof import("./tauri")>()),
  countPop3ServerDeletes: count,
}));

import { confirmMailDelete, deletesOnPop3Server, isAskingServerDelete, withServerDeleteWarning } from "./pop3Delete";
import { useAppStore } from "../stores/appStore";

const account = (id: string, incoming_protocol: "imap" | "pop3", pop3_delete_with_local: boolean) =>
  ({ id, email: "anna@studio-halde.example", incoming_protocol, pop3_delete_with_local }) as Account;
const use = (...accounts: Account[]) => useAppStore.setState({ accounts });
const t = i18n.t.bind(i18n);
const settle = () => new Promise((r) => setTimeout(r));
const warning = () => i18n.t("pop3.deleteWarning.mails", { count: 2 });

beforeEach(async () => {
  await i18n.changeLanguage("en");
  count.mockReset().mockResolvedValue(2);
  use(account("pop", "pop3", true), account("imap", "imap", true));
});

afterEach(settle);

describe("deletesOnPop3Server", () => {
  it("needs a POP3 account with the switch on", () => {
    expect(deletesOnPop3Server()).toBe(true);
    expect(deletesOnPop3Server("pop")).toBe(true);
    expect(deletesOnPop3Server("imap")).toBe(false);
    use(account("pop", "pop3", false), account("imap", "imap", true));
    expect(deletesOnPop3Server()).toBe(false);
  });
});

describe("withServerDeleteWarning", () => {
  it("adds the sentence only for affected accounts", () => {
    expect(withServerDeleteWarning(t, "Frage?", "folder", "pop")).toBe(`Frage? ${i18n.t("pop3.deleteWarning.folder")}`);
    expect(withServerDeleteWarning(t, "Frage?", "folder", "imap")).toBe("Frage?");
    expect(withServerDeleteWarning(t, "Frage?", "combined")).toBe(`Frage? ${i18n.t("pop3.deleteWarning.combined")}`);
    use(account("pop", "pop3", false));
    expect(withServerDeleteWarning(t, "Frage?", "combined")).toBe("Frage?");
  });

  it("says that the server copy goes at once", () => {
    expect(i18n.t("pop3.deleteWarning.mails", { count: 1 })).toContain("on the server immediately");
  });
});

describe("confirmMailDelete", () => {
  const danger = vi.fn();
  beforeEach(() => {
    danger.mockReset().mockResolvedValue(true);
  });

  it("asks nothing and queries nothing without an affected account", async () => {
    use(account("pop", "pop3", false));
    expect(await confirmMailDelete(danger, t, ["m1"])).toBe(true);
    expect(count).not.toHaveBeenCalled();
    expect(danger).not.toHaveBeenCalled();
  });

  it("asks nothing when no server copy would go", async () => {
    count.mockResolvedValue(0);
    expect(await confirmMailDelete(danger, t, ["m1"])).toBe(true);
    expect(danger).not.toHaveBeenCalled();
  });

  it("warns and follows the answer", async () => {
    expect(await confirmMailDelete(danger, t, ["m1", "m2"])).toBe(true);
    expect(count).toHaveBeenCalledWith(["m1", "m2"]);
    expect(danger.mock.calls[0][0]).toMatchObject({ title: i18n.t("pop3.deleteWarning.title"), message: warning() });
    await settle();
    danger.mockResolvedValue(false);
    expect(await confirmMailDelete(danger, t, ["m1", "m2"])).toBe(false);
  });

  it("adds the warning to an existing question", async () => {
    await confirmMailDelete(danger, t, ["m1", "m2"], { title: "Titel", message: "Frage?" });
    expect(danger).toHaveBeenCalledWith({ title: "Titel", message: `Frage? ${warning()}` });
  });

  it("keeps the existing question when no server copy would go", async () => {
    count.mockResolvedValue(0);
    await confirmMailDelete(danger, t, ["m1"], { title: "Titel", message: "Frage?" });
    expect(danger).toHaveBeenCalledWith({ title: "Titel", message: "Frage?" });
  });

  it("warns when the check fails", async () => {
    count.mockRejectedValue(new Error("offline"));
    await confirmMailDelete(danger, t, ["m1", "m2"]);
    expect(danger).toHaveBeenCalled();
  });

  it("refuses a second delete while the question is open", async () => {
    let answer!: (ok: boolean) => void;
    danger.mockImplementation(() => new Promise<boolean>((r) => { answer = r; }));
    const first = confirmMailDelete(danger, t, ["m1"]);
    await settle();
    expect(isAskingServerDelete()).toBe(true);
    expect(await confirmMailDelete(danger, t, ["m2"])).toBe(false);
    answer(false);
    expect(await first).toBe(false);
    await settle();
    expect(isAskingServerDelete()).toBe(false);
    expect(danger).toHaveBeenCalledTimes(1);
  });
});
