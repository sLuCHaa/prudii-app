import { describe, it, expect, beforeEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import i18n from "../lib/i18n";
import { useAppStore } from "../stores/appStore";
import type { Account } from "../types";

const { dangerMock, mutateMock } = vi.hoisted(() => ({ dangerMock: vi.fn(), mutateMock: vi.fn() }));

vi.mock("../components/ui/DialogProvider", () => ({ useDialog: () => ({ danger: dangerMock }) }));
vi.mock("./useAccounts", () => ({ useDeleteAccount: () => ({ mutate: mutateMock }) }));

import { useRemoveAccount } from "./useRemoveAccount";

const account = (id: string, incoming_protocol: Account["incoming_protocol"]) =>
  ({ id, email: `${id}@studio-halde.example`, incoming_protocol }) as Account;

async function remove(accountId: string) {
  let removeAccount!: (id: string) => Promise<void>;
  const root = createRoot(document.createElement("div"));
  function Probe() {
    removeAccount = useRemoveAccount();
    return null;
  }
  act(() => root.render(createElement(Probe)));
  await removeAccount(accountId);
  act(() => root.unmount());
}

beforeEach(() => {
  vi.clearAllMocks();
  useAppStore.setState({ accounts: [account("anna", "pop3"), account("info", "imap")] });
});

describe("useRemoveAccount", () => {
  it.each([
    ["anna", "pop3.deleteAccountBody"],
    ["info", "settings.deleteAccountConfirm.body"],
  ])("warns %s with %s", async (id, key) => {
    dangerMock.mockResolvedValue(true);
    await remove(id);
    expect(dangerMock).toHaveBeenCalledWith({
      title: i18n.t("settings.deleteAccountConfirm.title"),
      message: i18n.t(key),
      confirmLabel: i18n.t("settings.deleteAccountConfirm.confirm"),
      cancelLabel: i18n.t("settings.deleteAccountConfirm.cancel"),
    });
    expect(mutateMock).toHaveBeenCalledWith(id, expect.anything());
  });

  it("deletes nothing when cancelled", async () => {
    dangerMock.mockResolvedValue(false);
    await remove("anna");
    expect(mutateMock).not.toHaveBeenCalled();
  });
});
