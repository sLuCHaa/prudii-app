import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../../lib/i18n";
import { MailSortMenu } from "./MailSortMenu";
import type { MailSort } from "../../lib/mailSort";

let root: Root;
let host: HTMLDivElement;
let chosen: MailSort[];

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  chosen = [];
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function render(sort: MailSort) {
  act(() => root.render(createElement(MailSortMenu, { sort, onChange: (s: MailSort) => chosen.push(s) })));
}

const toggle = () => host.querySelector<HTMLButtonElement>("button[aria-haspopup=menu]")!;

function press(key: string) {
  act(() => {
    (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("MailSortMenu", () => {
  it("moves focus to the checked item when a click opens it", () => {
    render("subject_asc");
    act(() => toggle().click());
    expect(document.activeElement?.getAttribute("role")).toBe("menuitemradio");
    expect(document.activeElement?.textContent).toContain(i18n.t("mailList.sort.subject"));
  });

  it("picks the next field with the arrow keys and Enter", () => {
    render("date_desc");
    act(() => toggle().click());
    press("ArrowDown");
    press("Enter");
    expect(chosen).toEqual(["correspondent_asc"]);
  });

  it("closes on Escape, hands focus back and keeps the key from the list", () => {
    render("date_desc");
    act(() => toggle().click());
    let reachedWindow = false;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") reachedWindow = true;
    };
    window.addEventListener("keydown", onKey);
    press("Escape");
    window.removeEventListener("keydown", onKey);
    expect(host.querySelector("[role=menu]")).toBeNull();
    expect(document.activeElement).toBe(toggle());
    expect(reachedWindow).toBe(false);
  });
});
