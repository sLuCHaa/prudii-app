(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../../lib/i18n";
import de from "../../locales/de.json";
import { CategorySidebarEntries } from "./CategorySidebarEntries";

const openCategory = vi.fn();
const setActiveCategory = vi.fn();
let state: Record<string, unknown>;
let counts: { folder_id: string; category: string; unread: number; total: number }[];

vi.mock("../../stores/appStore", () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) => selector(state),
}));
vi.mock("../../hooks/useCategories", () => ({
  useCategoryCounts: () => ({ data: counts }),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  i18n.addResourceBundle("de", "translation", de, true, true);
  await i18n.changeLanguage("de");
  openCategory.mockClear();
  setActiveCategory.mockClear();
  counts = [
    { folder_id: "f1", category: "newsletters", unread: 2, total: 3 },
    { folder_id: "f2", category: "newsletters", unread: 1, total: 1 },
  ];
  state = {
    appSettings: { sorting_enabled: true, hidden_categories: ["social"] },
    activeCategory: null,
    showAllInboxes: false,
    selectedFolderId: null,
    openCategory,
    setActiveCategory,
  };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  await i18n.changeLanguage("en");
});

function render(inboxFolderId: string | null) {
  act(() => root.render(createElement(CategorySidebarEntries, { inboxFolderId })));
}

function rowOf(name: string) {
  return Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.startsWith(name));
}

describe("CategorySidebarEntries", () => {
  it("shows visible categories with the unread count of one inbox", () => {
    render("f1");
    expect(host.querySelectorAll("button")).toHaveLength(5);
    expect(rowOf("Newsletter")?.textContent).toBe("Newsletter2");
    expect(rowOf("Social")).toBeUndefined();
  });

  it("sums unread over all inboxes", () => {
    render(null);
    expect(rowOf("Newsletter")?.textContent).toBe("Newsletter3");
  });

  it("opens a category on click and clears it when already active", () => {
    render("f1");
    act(() => rowOf("Wichtig")!.click());
    expect(openCategory).toHaveBeenCalledWith("important", "f1");
    state = { ...state, activeCategory: "important", selectedFolderId: "f1" };
    render("f1");
    act(() => rowOf("Wichtig")!.click());
    expect(setActiveCategory).toHaveBeenCalledWith(null);
  });

  it("renders nothing when sorting is off", () => {
    state = { ...state, appSettings: { sorting_enabled: false, hidden_categories: [] } };
    render("f1");
    expect(host.innerHTML).toBe("");
  });
});
