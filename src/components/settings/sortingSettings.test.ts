(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "../../lib/i18n";
import de from "../../locales/de.json";
import type { AppSettings } from "../../types";
import { SortingSettings } from "./SortingSettings";

const listSenderCategories = vi.fn();
const deleteSenderCategory = vi.fn();
const resetCategories = vi.fn();
const danger = vi.fn();
const addToast = vi.fn();
const updateLocalSetting = vi.fn();

vi.mock("../../lib/tauri", () => ({
  listSenderCategories: () => listSenderCategories(),
  deleteSenderCategory: (email: string) => deleteSenderCategory(email),
  resetCategories: () => resetCategories(),
  categorizePendingMails: () => Promise.resolve(0),
}));
vi.mock("../ui/DialogProvider", () => ({
  useDialog: () => ({ danger }),
}));
vi.mock("../../stores/appStore", () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) => selector({ addToast }),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  i18n.addResourceBundle("de", "translation", de, true, true);
  await i18n.changeLanguage("de");
  for (const m of [listSenderCategories, deleteSenderCategory, resetCategories, danger, addToast, updateLocalSetting]) m.mockReset();
  listSenderCategories.mockResolvedValue([
    { email: "anna.weber@studio-halde.example", category: "important", created_at: "2026-11-01" },
  ]);
  deleteSenderCategory.mockResolvedValue(undefined);
  resetCategories.mockResolvedValue(undefined);
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
  const settings = { sorting_enabled: true, hidden_categories: [] } as unknown as AppSettings;
  await act(async () => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(SortingSettings, { localSettings: settings, updateLocalSetting }),
      ),
    );
  });
}

const buttonByText = (text: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === text)!;

describe("SortingSettings", () => {
  it("hides a category through its switch", async () => {
    await render();
    const row = Array.from(host.querySelectorAll("label")).find((l) => l.textContent?.includes("Social"))!;
    act(() => row.querySelector<HTMLButtonElement>("button[role=switch]")!.click());
    expect(updateLocalSetting).toHaveBeenCalledWith("hidden_categories", ["social"]);
  });

  it("lists remembered senders and removes one", async () => {
    await render();
    expect(host.textContent).toContain("anna.weber@studio-halde.example");
    expect(host.textContent).toContain("Wichtig");
    await act(async () => buttonByText("Entfernen").click());
    expect(deleteSenderCategory).toHaveBeenCalledWith("anna.weber@studio-halde.example");
  });

  it("resets only after the dialog is confirmed", async () => {
    danger.mockResolvedValueOnce(false);
    await render();
    await act(async () => buttonByText("Zurücksetzen").click());
    expect(resetCategories).not.toHaveBeenCalled();

    danger.mockResolvedValueOnce(true);
    await act(async () => buttonByText("Zurücksetzen").click());
    expect(resetCategories).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith("success", "Sortierung zurückgesetzt");
  });

  it("reports a failed sender removal instead of throwing", async () => {
    deleteSenderCategory.mockRejectedValueOnce(new Error("disk full"));
    await render();
    await act(async () => buttonByText("Entfernen").click());
    expect(addToast).toHaveBeenCalledWith("error", expect.any(String), "disk full");
  });

  it("reports a failed reset", async () => {
    danger.mockResolvedValueOnce(true);
    resetCategories.mockRejectedValueOnce(new Error("disk full"));
    await render();
    await act(async () => buttonByText("Zurücksetzen").click());
    expect(addToast).toHaveBeenCalledWith("error", expect.any(String), "disk full");
    expect(addToast).not.toHaveBeenCalledWith("success", expect.anything());
  });
});
