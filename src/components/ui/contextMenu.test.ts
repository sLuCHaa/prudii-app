(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { ContextMenu } from "./ContextMenu";
import type { MenuEntry } from "../../lib/menuModel";

let root: Root;
let host: HTMLDivElement;
beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

function key(k: string) {
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

describe("ContextMenu", () => {
  it("focuses the first item, navigates with arrows and activates with Enter", () => {
    const picked: string[] = [];
    let closed = 0;
    const entries: MenuEntry[] = [
      { kind: "item", id: "a", label: "Alpha", onSelect: () => picked.push("a") },
      { kind: "separator" },
      { kind: "item", id: "b", label: "Beta", onSelect: () => picked.push("b") },
    ];
    act(() => root.render(createElement(ContextMenu, { entries, x: 10, y: 10, onClose: () => closed++ })));

    expect(document.activeElement?.textContent).toContain("Alpha");
    key("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Beta");
    key("ArrowDown");
    expect(document.activeElement?.textContent).toContain("Alpha");
    key("End");
    key("Enter");
    expect(picked).toEqual(["b"]);
    expect(closed).toBe(1);
  });

  it("opens a submenu with ArrowRight, closes it with ArrowLeft, and closes all with Escape", () => {
    let closed = 0;
    const entries: MenuEntry[] = [
      { kind: "item", id: "snooze", label: "Snooze", submenu: [
        { kind: "item", id: "1h", label: "In 1 hour" },
        { kind: "item", id: "3h", label: "In 3 hours" },
      ] },
    ];
    act(() => root.render(createElement(ContextMenu, { entries, x: 10, y: 10, onClose: () => closed++ })));
    key("ArrowRight");
    expect(document.activeElement?.textContent).toContain("In 1 hour");
    key("ArrowDown");
    expect(document.activeElement?.textContent).toContain("In 3 hours");
    key("ArrowLeft");
    expect(document.activeElement?.textContent).toContain("Snooze");
    key("Escape");
    expect(closed).toBe(1);
  });

  it("supports type-ahead and restores focus on close", () => {
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();
    const entries: MenuEntry[] = [
      { kind: "item", id: "a", label: "Archive" },
      { kind: "item", id: "t", label: "Trash" },
    ];
    act(() => root.render(createElement(ContextMenu, { entries, x: 10, y: 10, onClose: () => {} })));
    key("t");
    expect(document.activeElement?.textContent).toContain("Trash");
    act(() => root.unmount());
    expect(document.activeElement).toBe(button);
    button.remove();
  });

  it("remounts the flyout when hover switches directly between sibling submenu items", () => {
    const entries: MenuEntry[] = [
      { kind: "item", id: "move", label: "Move", submenu: [
        { kind: "item", id: "inbox", label: "Inbox" },
        { kind: "item", id: "archive-dest", label: "Archive" },
      ] },
      { kind: "item", id: "snooze", label: "Snooze", submenu: [
        { kind: "item", id: "1h", label: "1h" },
        { kind: "item", id: "3h", label: "3h" },
      ] },
    ];
    act(() => root.render(createElement(ContextMenu, { entries, x: 10, y: 10, onClose: () => {} })));
    key("ArrowRight");
    expect(document.activeElement?.textContent).toContain("Inbox");

    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    const snoozeButton = Array.from(menu.querySelectorAll<HTMLElement>('[data-index]')).find((b) => b.textContent?.includes("Snooze"));
    act(() => {
      snoozeButton?.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    });
    // tagName check matters: without the fix focus is dropped to <body> when the
    // old submenu buttons unmount, and body.textContent still contains "1h" as a
    // substring of the concatenated menu text, so a plain toContain would pass anyway.
    expect(document.activeElement?.tagName).toBe("BUTTON");
    expect(document.activeElement?.textContent).toBe("1h");
  });

  it("tints a danger item's icon wrapper with text-danger", () => {
    const entries: MenuEntry[] = [
      { kind: "item", id: "trash", label: "Trash", icon: createElement("span", null, "i"), danger: true },
    ];
    act(() => root.render(createElement(ContextMenu, { entries, x: 10, y: 10, onClose: () => {} })));
    const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.includes("Trash"));
    const iconWrapper = button?.firstElementChild;
    expect(iconWrapper?.className).toContain("text-danger");
  });

  it("uses listbox roles in listbox variant", () => {
    const entries: MenuEntry[] = [{ kind: "item", id: "a", label: "A", selected: true }];
    act(() => root.render(createElement(ContextMenu, { entries, x: 0, y: 0, onClose: () => {}, variant: "listbox" })));
    const opt = document.querySelector('[role="option"]');
    expect(opt?.getAttribute("aria-selected")).toBe("true");
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
  });
});
