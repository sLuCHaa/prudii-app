import { describe, it, expect, beforeEach, vi } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import i18n from "./i18n";
import type { Account, Folder } from "../types";

const calls = vi.hoisted(() => ({
  copy: [] as [string, string][],
  sync: [] as [string, string][],
  trash: [] as string[],
  failCopy: false,
}));

vi.mock("./tauri", async (original) => ({
  ...(await original<typeof import("./tauri")>()),
  copyMailToFolder: async (mailId: string, destFolderId: string) => {
    calls.copy.push([mailId, destFolderId]);
    if (calls.failCopy) throw new Error("connection timeout");
  },
  syncFolder: async (accountId: string, folderId: string) => { calls.sync.push([accountId, folderId]); },
  trashMail: async (mailId: string) => { calls.trash.push(mailId); },
}));

import { copyToOtherAccount } from "./copyMail";
import { useAppStore } from "../stores/appStore";

const client = { invalidateQueries: async () => {} } as unknown as QueryClient;
const offers: Folder = { id: "f-offers", account_id: "info", name: "Angebote", folder_type: "custom", path: "Angebote", unread_count: 0, total_count: 0, is_local: false, color: "" };
const info = { id: "info", email: "info@studio-halde.example" } as Account;
const toasts = () => useAppStore.getState().toasts;

beforeEach(() => {
  calls.copy.length = 0;
  calls.sync.length = 0;
  calls.trash.length = 0;
  calls.failCopy = false;
  useAppStore.setState({ toasts: [], pendingRemoveIds: [] });
});

describe("copyToOtherAccount", () => {
  it("copies the mail into the picked folder", async () => {
    await copyToOtherAccount(client, { id: "m1" }, offers, info);
    expect(calls.copy).toEqual([["m1", "f-offers"]]);
  });

  it("says where the copy went", async () => {
    await copyToOtherAccount(client, { id: "m1" }, offers, info);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].type).toBe("success");
    expect(toasts()[0].title).toBe(i18n.t("folder.copied", { folder: "Angebote" }));
    expect(toasts()[0].message).toBe("info@studio-halde.example");
  });

  it("names a standard folder the way the sidebar does", async () => {
    await copyToOtherAccount(client, { id: "m1" }, { ...offers, folder_type: "archive", name: "Archive" }, info);
    expect(toasts()[0].title).toBe(i18n.t("folder.copied", { folder: i18n.t("folder.types.archive") }));
  });

  it("fetches the copy into the local list", async () => {
    await copyToOtherAccount(client, { id: "m1" }, offers, info);
    expect(calls.sync).toEqual([["info", "f-offers"]]);
  });

  it("leaves the original alone", async () => {
    await copyToOtherAccount(client, { id: "m1" }, offers, info);
    expect(calls.trash).toEqual([]);
    expect(useAppStore.getState().pendingRemoveIds).toEqual([]);
  });

  it("offers to bin the original, which makes it a move", async () => {
    await copyToOtherAccount(client, { id: "m1" }, offers, info);
    const action = toasts()[0].action!;
    expect(action.label).toBe(i18n.t("folder.trashOriginal"));
    action.onClick();
    expect(useAppStore.getState().pendingRemoveIds).toEqual(["m1"]);
    expect(calls.trash).toEqual(["m1"]);
  });

  it("reports a failed copy and offers nothing further", async () => {
    calls.failCopy = true;
    await copyToOtherAccount(client, { id: "m1" }, offers, info);
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0].type).toBe("error");
    expect(toasts()[0].title).toBe(i18n.t("errors.copy"));
    expect(toasts()[0].action).toBeUndefined();
    expect(calls.sync).toEqual([]);
  });
});
