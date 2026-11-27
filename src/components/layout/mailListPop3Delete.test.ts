import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "../../lib/i18n";
import type { Account } from "../../types";

const { invoke, danger } = vi.hoisted(() => ({ invoke: vi.fn(), danger: vi.fn() }));

vi.mock("@tauri-apps/api/core", async (original) => ({ ...(await original<typeof import("@tauri-apps/api/core")>()), invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {}, emit: async () => {} }));
vi.mock("../ui/DialogProvider", () => ({ useDialog: () => ({ danger, confirm: vi.fn(), alert: vi.fn(), isOpen: false }) }));

import { MailList } from "./MailList";
import { useAppStore } from "../../stores/appStore";

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

const account = (pop3_delete_with_local: boolean) =>
  ({ id: "pop", email: "anna@studio-halde.example", incoming_protocol: "pop3", pop3_delete_with_local }) as Account;

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });
const calls = (command: string) => invoke.mock.calls.filter(([name]) => name === command);

beforeEach(async () => {
  await i18n.changeLanguage("en");
  vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  Element.prototype.scrollTo = () => {};
  invoke.mockReset().mockImplementation(async (command: string) => {
    if (command === "count_pop3_server_deletes") return 2;
    if (command === "count_combined_folder_mails") return 3;
    if (command === "list_combined_folder_mails") return [{ id: "m1", account_id: "pop", folder_id: "folder-trash", message_id: "", from: { name: "Anna Weber", email: "anna@studio-halde.example" }, to: [], cc: [], subject: "Angebot", preview: "", date: "2026-11-01T08:00:00Z", flags: [] }];
    return command.startsWith("count") ? 0 : [];
  });
  danger.mockReset().mockResolvedValue(false);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useAppStore.setState({
    accounts: [account(true)],
    selectedFolderId: "folder-trash",
    activeCombinedFolder: null,
    multiSelectMode: true,
    selectedMailIds: new Set(["m1", "m2"]),
    pendingRemoveIds: [],
  });
});

afterEach(async () => {
  await flush();
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
  vi.unstubAllGlobals();
});

async function render() {
  act(() => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(MailList)));
  });
  await flush();
}

const click = async (el: Element) => {
  await act(async () => { el.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
  await flush();
};

const press = async (key: string) => {
  await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true })); });
  await flush();
};

const clickTrash = () => click(host.querySelector(`button[aria-label="${i18n.t("mailDetail.trash")}"]`)!);

describe.each([
  ["the Delete key", () => press("Delete")],
  ["the toolbar button", clickTrash],
] as const)("deleting a selection with %s", (_name, trigger) => {
  it("changes nothing when the server warning is cancelled", async () => {
    await render();
    await trigger();
    expect(danger).toHaveBeenCalledTimes(1);
    expect(danger.mock.calls[0][0].message).toBe(i18n.t("pop3.deleteWarning.mails", { count: 2 }));
    expect(calls("batch_update_mails")).toEqual([]);
    expect(useAppStore.getState().pendingRemoveIds).toEqual([]);
    expect([...useAppStore.getState().selectedMailIds]).toEqual(["m1", "m2"]);
  });

  it("deletes after confirmation", async () => {
    danger.mockResolvedValue(true);
    await render();
    await trigger();
    expect(calls("batch_update_mails")).toEqual([["batch_update_mails", { mailIds: ["m1", "m2"], action: "trash" }]]);
    expect(useAppStore.getState().selectedMailIds.size).toBe(0);
  });

  it("asks nothing with the switch off", async () => {
    useAppStore.setState({ accounts: [account(false)] });
    await render();
    await trigger();
    expect(danger).not.toHaveBeenCalled();
    expect(calls("count_pop3_server_deletes")).toEqual([]);
    expect(calls("batch_update_mails")).toHaveLength(1);
  });
});

describe("keys while the warning is open", () => {
  it("leave the selection alone", async () => {
    danger.mockImplementation(() => new Promise<boolean>(() => {}));
    await render();
    await press("Delete");
    await press("Escape");
    await press("e");
    await press("Delete");
    expect(danger).toHaveBeenCalledTimes(1);
    expect(calls("batch_update_mails")).toEqual([]);
    expect(useAppStore.getState().selectedMailIds.size).toBe(2);
  });
});

describe("emptying a combined folder", () => {
  it("names the server deletion and keeps everything on cancel", async () => {
    useAppStore.setState({ selectedFolderId: null, activeCombinedFolder: "trash", multiSelectMode: false, selectedMailIds: new Set() });
    await render();
    const label = i18n.t("mailList.emptyAll");
    const button = Array.from(host.querySelectorAll("button")).find(
      (b) => b.getAttribute("aria-label") === label || b.textContent?.includes(label),
    )!;
    await click(button);
    expect(danger.mock.calls[0][0].message).toContain(i18n.t("pop3.deleteWarning.combined"));
    expect(calls("empty_all_trash")).toEqual([]);
  });
});
