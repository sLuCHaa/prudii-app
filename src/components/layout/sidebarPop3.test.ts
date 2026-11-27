import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import type { Account, Folder, IncomingProtocol } from "../../types";

const { createFolder, forceResyncAccount, confirm, danger, deleteFolder, emptyTrash, mutate, folderList } = vi.hoisted(() => ({
  createFolder: vi.fn(),
  forceResyncAccount: vi.fn(),
  confirm: vi.fn(),
  danger: vi.fn(),
  deleteFolder: vi.fn(),
  emptyTrash: vi.fn(),
  mutate: vi.fn(),
  folderList: { current: [] as unknown[] },
}));

vi.mock("../../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/tauri")>()),
  createFolder,
  forceResyncAccount,
  deleteFolder,
  emptyTrash,
  countFolderMails: async () => 2,
}));
vi.mock("../../hooks/useAccounts", () => ({
  useAccounts: () => ({ data: [] }),
  useFolders: () => ({ data: folderList.current }),
  prefetchFolderMails: vi.fn(),
  useStarredCount: () => ({ data: 0 }),
}));
vi.mock("../../hooks/useSync", () => ({
  useSyncAccount: () => ({ mutate, isPending: false }),
  useSyncAll: () => ({ mutate: vi.fn(), isPending: false }),
}));
vi.mock("../../hooks/useRemoveAccount", () => ({ useRemoveAccount: () => vi.fn() }));
vi.mock("../ui/DialogProvider", () => ({ useDialog: () => ({ confirm, alert: vi.fn(), danger }) }));

import { AccountSection } from "./Sidebar";

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

const account = (incoming_protocol: IncomingProtocol) =>
  ({
    id: crypto.randomUUID(),
    email: "anna@studio-halde.example",
    display_name: "Anna Weber",
    color: "#3b82f6",
    provider: "custom",
    auth_type: "password",
    incoming_protocol,
  }) as Account;

const inbox = {
  id: "folder-inbox",
  name: "INBOX",
  folder_type: "inbox",
  is_local: false,
  unread_count: 0,
  total_count: 0,
  color: "",
} as Folder;

beforeEach(async () => {
  await i18n.changeLanguage("en");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  createFolder.mockReset().mockResolvedValue(undefined);
  forceResyncAccount.mockReset().mockResolvedValue(undefined);
  confirm.mockReset().mockResolvedValue(true);
  mutate.mockReset();
  danger.mockReset().mockResolvedValue(false);
  deleteFolder.mockReset().mockResolvedValue(undefined);
  emptyTrash.mockReset().mockResolvedValue(2);
  folderList.current = [inbox];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
  document.body.innerHTML = "";
});

function render(a: Account, collapsed = false) {
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(AccountSection, { account: a, collapsed })),
    );
  });
}

function rightClick(el: Element) {
  act(() => {
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
  });
}

async function click(el: Element, init: MouseEventInit = {}) {
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
  });
}

function menuItem(label: string) {
  return Array.from(document.body.querySelectorAll('[role^="menuitem"]')).find((el) => el.textContent?.includes(label));
}

function buttonNamed(label: string) {
  return Array.from(document.body.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
}

const accountHeader = () => host.querySelector(".group")!;
const collapsedDot = () => host.querySelector('button[title="Anna Weber"]')!;
const syncButton = () => accountHeader().querySelector(":scope > button:last-of-type")!;

describe.each([
  ["expanded", false, accountHeader],
  ["collapsed", true, collapsedDot],
] as const)("account menu (%s sidebar)", (_name, collapsed, target) => {
  it("offers no resync for POP3", () => {
    render(account("pop3"), collapsed);
    rightClick(target());
    expect(menuItem(i18n.t("sidebar.accountMenu.sync"))).toBeDefined();
    expect(menuItem(i18n.t("sidebar.forceResyncTitle"))).toBeUndefined();
  });

  it("offers resync for IMAP", () => {
    render(account("imap"), collapsed);
    rightClick(target());
    expect(menuItem(i18n.t("sidebar.forceResyncTitle"))).toBeDefined();
  });
});

describe("shift-click on the sync button", () => {
  it("runs a normal sync for POP3", async () => {
    const a = account("pop3");
    render(a);
    await click(syncButton(), { shiftKey: true });
    expect(mutate).toHaveBeenCalledWith(a.id);
    expect(confirm).not.toHaveBeenCalled();
    expect(forceResyncAccount).not.toHaveBeenCalled();
  });

  it("still resyncs IMAP", async () => {
    const a = account("imap");
    render(a);
    await click(syncButton(), { shiftKey: true });
    expect(forceResyncAccount).toHaveBeenCalledWith(a.id);
    expect(mutate).not.toHaveBeenCalled();
  });
});

async function createNamedFolder(name: string) {
  const input = document.body.querySelector<HTMLInputElement>(`input[placeholder="${i18n.t("folder.folderName")}"]`)!;
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await click(buttonNamed(i18n.t("common.create"))!);
}

async function openCreateDialog() {
  rightClick(accountHeader());
  await click(menuItem(i18n.t("sidebar.newFolder"))!);
}

describe("create folder dialog", () => {
  it("has no server choice for POP3 and creates a local folder", async () => {
    const a = account("pop3");
    render(a);
    await openCreateDialog();
    expect(buttonNamed(i18n.t("common.server"))).toBeUndefined();
    expect(buttonNamed(i18n.t("common.localOnly"))).toBeUndefined();
    await createNamedFolder("Projects");
    expect(createFolder).toHaveBeenCalledWith(a.id, "Projects", true);
  });

  it("defaults to a server folder for IMAP", async () => {
    const a = account("imap");
    render(a);
    await openCreateDialog();
    expect(buttonNamed(i18n.t("common.server"))).toBeDefined();
    await createNamedFolder("Projects");
    expect(createFolder).toHaveBeenCalledWith(a.id, "Projects", false);
  });
});

describe.each([
  ["expanded", false],
  ["collapsed", true],
] as const)("folder context menu (%s sidebar)", (_name, collapsed) => {
  const folderRow = () =>
    collapsed
      ? host.querySelector(`button[title="${i18n.t("folder.types.inbox")}"]`)!
      : Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(i18n.t("folder.types.inbox")))!;

  it("heads POP3 folders as local", () => {
    render(account("pop3"), collapsed);
    rightClick(folderRow());
    expect(document.body.textContent).toContain(i18n.t("folder.localFolder"));
    expect(document.body.textContent).not.toContain(i18n.t("folder.serverFolder"));
  });

  it("heads IMAP folders as server folders", () => {
    render(account("imap"), collapsed);
    rightClick(folderRow());
    expect(document.body.textContent).toContain(i18n.t("folder.serverFolder"));
  });
});

describe("permanently deleting folders", () => {
  const projects = { ...inbox, id: "folder-projects", name: "Projects", path: "Projects", folder_type: "custom", is_local: true } as Folder;
  const trash = { ...inbox, id: "folder-trash", name: "Trash", folder_type: "trash" } as Folder;
  const row = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.includes(label))!;
  const routes = [
    ["deleting a folder", () => "Projects", "common.delete", deleteFolder],
    ["emptying the trash", () => i18n.t("folder.types.trash"), "folder.emptyTrash", emptyTrash],
  ] as const;

  async function choose(rowLabel: () => string, entry: string, withLocal: boolean) {
    const a = { ...account("pop3"), pop3_delete_with_local: withLocal };
    useAppStore.setState({ accounts: [a] });
    folderList.current = [inbox, trash, projects];
    render(a);
    rightClick(row(rowLabel()));
    await click(menuItem(i18n.t(entry))!);
  }

  it.each(routes)("warns about the server when %s and keeps it on cancel", async (_name, rowLabel, entry, command) => {
    await choose(rowLabel, entry, true);
    expect(danger.mock.calls[0][0].message).toContain(i18n.t("pop3.deleteWarning.folder"));
    expect(command).not.toHaveBeenCalled();
  });

  it.each(routes)("says nothing about the server when %s with the switch off", async (_name, rowLabel, entry) => {
    await choose(rowLabel, entry, false);
    expect(danger.mock.calls[0][0].message).not.toContain(i18n.t("pop3.deleteWarning.folder"));
  });
});
