(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../../lib/i18n";
import de from "../../locales/de.json";
import type { Mail } from "../../types";
import { CategoryChip } from "./CategoryChip";

const mutate = vi.fn();
let state: Record<string, unknown>;

vi.mock("../../stores/appStore", () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) => selector(state),
}));
vi.mock("../../hooks/useCategories", () => ({
  useMailCategoryInfo: () => ({
    data: {
      category: "newsletters",
      reasons: [{ code: "mailing_list", params: {} }],
      sender: "news@designweekly.example",
      sender_rule: null,
      source: "heuristic",
    },
  }),
  useSetMailCategory: () => ({ mutate }),
}));

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  i18n.addResourceBundle("de", "translation", de, true, true);
  await i18n.changeLanguage("de");
  mutate.mockClear();
  state = { appSettings: { sorting_enabled: true, hidden_categories: [] } };
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  await i18n.changeLanguage("en");
});

function render(category: string | null, onRowClick = vi.fn()) {
  const mail = { id: "m1", category } as Mail;
  act(() => root.render(createElement("div", { onClick: onRowClick }, createElement(CategoryChip, { mail }))));
  return onRowClick;
}

const chip = () => host.querySelector("button");
const popover = () => document.body.querySelector("[role=dialog]");
const button = (text: string) => Array.from(popover()!.querySelectorAll("button")).find((b) => b.textContent === text)!;

describe("CategoryChip", () => {
  it("shows the category name", () => {
    render("newsletters");
    expect(chip()?.textContent).toBe("Newsletter");
  });

  it("renders nothing for hidden categories, no category and sorting off", () => {
    state = { appSettings: { sorting_enabled: true, hidden_categories: ["newsletters"] } };
    render("newsletters");
    expect(host.innerHTML).toBe("<div></div>");
    state = { appSettings: { sorting_enabled: true, hidden_categories: [] } };
    render(null);
    expect(host.innerHTML).toBe("<div></div>");
    state = { appSettings: { sorting_enabled: false, hidden_categories: [] } };
    render("newsletters");
    expect(host.innerHTML).toBe("<div></div>");
  });

  it("opens the popover with reasons without selecting the row", () => {
    const rowClick = render("newsletters");
    act(() => chip()!.click());
    expect(rowClick).not.toHaveBeenCalled();
    expect(popover()?.textContent).toContain("Warum „Newsletter“?");
    expect(popover()?.textContent).toContain("Kommt über eine Mailingliste");
  });

  it("corrects the category and remembers the sender by default", () => {
    render("newsletters");
    act(() => chip()!.click());
    act(() => button("Wichtig").click());
    expect(mutate).toHaveBeenCalledWith({ mailId: "m1", category: "important", rememberSender: true });
    expect(popover()).toBeNull();
  });

  it("does not remember the sender once unchecked", () => {
    render("newsletters");
    act(() => chip()!.click());
    act(() => (popover()!.querySelector("input[type=checkbox]") as HTMLInputElement).click());
    act(() => button("Keine").click());
    expect(mutate).toHaveBeenCalledWith({ mailId: "m1", category: null, rememberSender: false });
  });

  it("closes on Escape", () => {
    render("newsletters");
    act(() => chip()!.click());
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    expect(popover()).toBeNull();
  });
});
