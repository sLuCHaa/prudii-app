(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "../../lib/i18n";
import de from "../../locales/de.json";
import { useAppStore } from "../../stores/appStore";
import { MailExportSection } from "./MailExportSection";

const startMailExport = vi.fn();
const listAccounts = vi.fn();
const listFolders = vi.fn();
const openLastExportFolder = vi.fn();
const alert = vi.fn();
const scrollIntoView = vi.fn();

vi.mock("../../lib/tauri", () => ({
  startMailExport: (...args: unknown[]) => startMailExport(...args),
  listAccounts: () => listAccounts(),
  listFolders: (id: string) => listFolders(id),
  openLastExportFolder: () => openLastExportFolder(),
}));
vi.mock("../ui/DialogProvider", () => ({
  useDialog: () => ({ alert }),
}));

const folderOf = (id: string, account_id: string, folder_type: string) => ({
  id, account_id, name: id, folder_type, path: id, unread_count: 0, total_count: 0, is_local: false, color: "",
});

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  i18n.addResourceBundle("de", "translation", de, true, true);
  await i18n.changeLanguage("de");
  for (const m of [startMailExport, listAccounts, listFolders, openLastExportFolder, alert, scrollIntoView]) m.mockReset();
  HTMLElement.prototype.scrollIntoView = scrollIntoView;
  startMailExport.mockResolvedValue(true);
  alert.mockResolvedValue(undefined);
  listAccounts.mockResolvedValue([
    { id: "a1", email: "anna.weber@studio-halde.example", display_name: "Anna Weber", color: "#000" },
    { id: "a2", email: "jonas.brandt@studio-halde.example", display_name: "Jonas Brandt", color: "#111" },
  ]);
  listFolders.mockImplementation(async (id: string) => [
    folderOf(`${id}-in`, id, "inbox"),
    folderOf(`${id}-trash`, id, "trash"),
    folderOf(`${id}-spam`, id, "spam"),
    folderOf(`${id}-sent`, id, "sent"),
  ]);
  useAppStore.setState({
    mailExport: { running: false, progress: null, result: null },
    mailExportPreselect: null,
  });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  await i18n.changeLanguage("en");
});

async function render() {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: new QueryClient() }, createElement(MailExportSection)));
  });
  for (let i = 0; i < 3; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
}

function checkbox(label: string): HTMLInputElement {
  const el = [...host.querySelectorAll("label")].find((l) => l.textContent?.includes(label));
  if (!el) throw new Error(`no label ${label}`);
  return el.querySelector("input") as HTMLInputElement;
}

function exportButton(): HTMLButtonElement {
  return [...host.querySelectorAll("button")].find((b) => b.textContent === de.mailExport.exportButton) as HTMLButtonElement;
}

describe("MailExportSection", () => {
  it("checks only the preselected account", async () => {
    useAppStore.setState({ mailExportPreselect: "a2" });
    await render();
    expect(checkbox("anna.weber@studio-halde.example").checked).toBe(false);
    expect(checkbox("jonas.brandt@studio-halde.example").checked).toBe(true);
    expect(useAppStore.getState().mailExportPreselect).toBeNull();
  });

  it("shows the noFormat text without starting when both formats are off", async () => {
    await render();
    await act(async () => { checkbox(de.mailExport.formatHtml).click(); });
    await act(async () => { checkbox(de.mailExport.formatEml).click(); });
    await act(async () => { exportButton().click(); });
    expect(startMailExport).not.toHaveBeenCalled();
    expect(alert).toHaveBeenCalledWith(expect.objectContaining({ message: de.mailExport.errors.noFormat }));
  });

  it("starts with all folders except trash and spam", async () => {
    await render();
    await act(async () => { exportButton().click(); });
    expect(startMailExport).toHaveBeenCalledTimes(1);
    const [options, labels] = startMailExport.mock.calls[0];
    expect(options).toEqual({
      folderIds: ["a1-in", "a1-sent", "a2-in", "a2-sent"],
      html: true,
      eml: true,
      includeAttachments: true,
    });
    expect(labels.title).toBe(de.mailExport.page.title);
  });

  it("leaves an unticked account out and lets it be ticked again", async () => {
    await render();
    const anna = () => checkbox("anna.weber@studio-halde.example");
    await act(async () => { anna().click(); });
    expect(anna().checked).toBe(false);
    await act(async () => { exportButton().click(); });
    expect(startMailExport.mock.calls[0][0].folderIds).toEqual(["a2-in", "a2-sent"]);
    await act(async () => { anna().click(); });
    expect(anna().checked).toBe(true);
  });

  it("adds another account to a preselected one", async () => {
    useAppStore.setState({ mailExportPreselect: "a2" });
    await render();
    await act(async () => { checkbox("anna.weber@studio-halde.example").click(); });
    await act(async () => { exportButton().click(); });
    expect(startMailExport.mock.calls[0][0].folderIds).toEqual(["a1-in", "a1-sent", "a2-in", "a2-sent"]);
  });

  it("scrolls into view when opened from the account menu", async () => {
    await render();
    expect(scrollIntoView).not.toHaveBeenCalled();
    act(() => root.unmount());
    root = createRoot(host);
    useAppStore.setState({ mailExportPreselect: "a2" });
    await render();
    expect(scrollIntoView).toHaveBeenCalled();
  });

  it("disables the button while the export is starting", async () => {
    let finish: (v: boolean) => void = () => {};
    startMailExport.mockReturnValue(new Promise<boolean>((r) => { finish = r; }));
    await render();
    await act(async () => { exportButton().click(); });
    expect(exportButton().disabled).toBe(true);
    await act(async () => { exportButton().click(); });
    expect(startMailExport).toHaveBeenCalledTimes(1);
    await act(async () => { finish(true); });
    expect(exportButton().disabled).toBe(false);
  });

  it("shows the last result with its counts and an open-folder button", async () => {
    useAppStore.setState({
      mailExport: { running: false, progress: null, result: { path: "x", exported: 98, localCopy: 1, failed: 1, cancelled: false } },
    });
    await render();
    const text = host.textContent ?? "";
    expect(text).toContain(de.mailExport.doneTitle);
    expect(text).toContain("99");
    expect(text).toContain(de.mailExport.openFolder);
    const open = [...host.querySelectorAll("button")].find((b) => b.textContent === de.mailExport.openFolder)!;
    await act(async () => { open.click(); });
    expect(openLastExportFolder).toHaveBeenCalled();
  });
});
