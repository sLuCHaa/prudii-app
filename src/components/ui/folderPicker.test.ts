(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../../lib/i18n";
import type { Folder } from "../../types";
import { FolderPicker } from "./FolderPicker";

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

function folder(id: string, name: string, folder_type: Folder["folder_type"] = "custom"): Folder {
  return { id, account_id: "a1", name, folder_type, path: name, unread_count: 0, total_count: 0, is_local: false, color: "" };
}

const FOLDERS = [folder("f-archive", "Archive", "archive"), folder("f-offers", "Angebote"), folder("f-plan", "Planung")];

function render(props: Partial<Parameters<typeof FolderPicker>[0]> = {}) {
  act(() =>
    root.render(
      createElement(FolderPicker, { folders: FOLDERS, x: 10, y: 10, onPick: () => {}, onClose: () => {}, ...props }),
    ),
  );
}

const input = () => document.querySelector<HTMLInputElement>("input")!;
const options = () => Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => o.textContent?.trim());

function type(text: string) {
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setValue.call(input(), text);
    input().dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(key: string) {
  act(() => {
    input().dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  });
}

describe("FolderPicker", () => {
  it("lists the folders the way the sidebar names them", () => {
    render();
    expect(options()).toEqual([i18n.t("folder.types.archive"), "Angebote", "Planung"]);
  });

  it("names the account the folders belong to", () => {
    render({ accountLabel: "anna@studio-halde.example" });
    expect(document.body.textContent).toContain("anna@studio-halde.example");
  });

  it("starts with the cursor in the search field", () => {
    render();
    expect(document.activeElement).toBe(input());
  });

  it("narrows the list as the user types", () => {
    render();
    type("plan");
    expect(options()).toEqual(["Planung"]);
  });

  it("says so when no folder matches", () => {
    render();
    type("xyz");
    expect(options()).toEqual([]);
    expect(document.body.textContent).toContain(i18n.t("folder.noFolderFound"));
  });

  it("picks the first match on Enter and closes", () => {
    const picked: string[] = [];
    let closed = 0;
    render({ onPick: (id) => picked.push(id), onClose: () => { closed += 1; } });
    type("an");
    press("Enter");
    expect(picked).toEqual(["f-offers"]);
    expect(closed).toBe(1);
  });

  it("moves the highlight with the arrow keys", () => {
    const picked: string[] = [];
    render({ onPick: (id) => picked.push(id) });
    press("ArrowDown");
    press("ArrowDown");
    press("Enter");
    expect(picked).toEqual(["f-plan"]);
  });

  it("wraps from the first folder to the last", () => {
    const picked: string[] = [];
    render({ onPick: (id) => picked.push(id) });
    press("ArrowUp");
    press("Enter");
    expect(picked).toEqual(["f-plan"]);
  });

  it("picks a folder on click", () => {
    const picked: string[] = [];
    render({ onPick: (id) => picked.push(id) });
    act(() => document.querySelectorAll<HTMLElement>('[role="option"]')[1].click());
    expect(picked).toEqual(["f-offers"]);
  });

  it("closes on Escape without picking", () => {
    const picked: string[] = [];
    let closed = 0;
    render({ onPick: (id) => picked.push(id), onClose: () => { closed += 1; } });
    press("Escape");
    expect(picked).toEqual([]);
    expect(closed).toBe(1);
  });

  const INFO = [folder("i-inbox", "INBOX", "inbox"), folder("i-offers", "Angebote Kunden")];
  const GROUPS = [{ label: "Kopieren nach info@studio-halde.example", folders: INFO }];

  it("lists another account's folders under their own heading", () => {
    render({ groups: GROUPS });
    expect(options()).toEqual([i18n.t("folder.types.archive"), "Angebote", "Planung", i18n.t("folder.types.inbox"), "Angebote Kunden"]);
    expect(document.body.textContent).toContain("Kopieren nach info@studio-halde.example");
  });

  it("searches the folders of every account", () => {
    render({ groups: GROUPS });
    type("angeb");
    expect(options()).toEqual(["Angebote", "Angebote Kunden"]);
  });

  it("drops the heading of an account without a match", () => {
    render({ groups: GROUPS });
    type("plan");
    expect(document.body.textContent).not.toContain("Kopieren nach info@studio-halde.example");
  });

  it("walks through every account with the arrow keys", () => {
    const picked: string[] = [];
    render({ groups: GROUPS, onPick: (id) => picked.push(id) });
    press("ArrowUp");
    press("Enter");
    expect(picked).toEqual(["i-offers"]);
  });

  it("reports a folder picked in another account", () => {
    const picked: string[] = [];
    render({ groups: GROUPS, onPick: (id) => picked.push(id) });
    act(() => document.querySelectorAll<HTMLElement>('[role="option"]')[3].click());
    expect(picked).toEqual(["i-inbox"]);
  });

  it("closes on a click outside", () => {
    let closed = 0;
    render({ onClose: () => { closed += 1; } });
    act(() => { document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); });
    expect(closed).toBe(1);
  });
});
