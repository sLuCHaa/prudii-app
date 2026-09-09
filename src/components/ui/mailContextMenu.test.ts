(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../../lib/i18n";
import { MAIL_FLAG_COLORS, type Folder, type Mail, type MailFlag } from "../../types";
import { FLAG_ORDER } from "../../lib/mailFlags";
import { MailContextMenu } from "./MailContextMenu";

vi.mock("../../stores/appStore", () => ({
  useAppStore: (selector: (s: { hasFeature: () => boolean }) => unknown) => selector({ hasFeature: () => true }),
}));

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

function makeMail(overrides: Partial<Mail> = {}): Mail {
  return {
    id: "m1",
    account_id: "a1",
    folder_id: "f1",
    subject: "Subject",
    flags: [],
    is_read: false,
    is_starred: false,
    is_pinned: false,
    has_attachments: false,
    ...overrides,
  } as Mail;
}

const noop = () => {};

function render(props: Partial<Parameters<typeof MailContextMenu>[0]> = {}) {
  act(() =>
    root.render(
      createElement(MailContextMenu, {
        mail: makeMail(),
        x: 10,
        y: 10,
        onClose: noop,
        onReply: noop,
        onReplyAll: noop,
        onForward: noop,
        onToggleStar: noop,
        onCreateTask: noop,
        onAddToTask: noop,
        onToggleRead: noop,
        onArchive: noop,
        onTrash: noop,
        ...props,
      }),
    ),
  );
}

/** Menu labels come from i18n, so look them up rather than hardcoding a language. */
function item(key: string): HTMLElement | undefined {
  const label = i18n.t(key);
  return Array.from(document.querySelectorAll<HTMLElement>("button")).find((b) => b.textContent?.trim() === label);
}

function flagItem(flag: MailFlag): HTMLElement | undefined {
  return item(MAIL_FLAG_COLORS[flag].nameKey);
}

function folder(id: string, name: string, folder_type = "custom"): Folder {
  return {
    id,
    account_id: "a1",
    name,
    folder_type: folder_type as Folder["folder_type"],
    path: name,
    unread_count: 0,
    total_count: 0,
    is_local: false,
    color: "",
  };
}

function openSubmenu(key: string) {
  const trigger = item(key);
  expect(trigger, `submenu trigger "${key}" missing`).toBeTruthy();
  act(() => trigger!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
}

function openFlagSubmenu() {
  const trigger = item("flags.title");
  expect(trigger, "flag submenu trigger missing").toBeTruthy();
  act(() => trigger!.dispatchEvent(new MouseEvent("mouseover", { bubbles: true })));
}

describe("MailContextMenu flags", () => {
  it("offers a flag submenu with every colour when onToggleFlag is wired", () => {
    render({ onToggleFlag: noop });
    openFlagSubmenu();
    for (const flag of FLAG_ORDER) {
      expect(flagItem(flag), `missing flag "${flag}"`).toBeTruthy();
    }
  });

  it("has no flag entry at all when the handler is absent", () => {
    render();
    expect(item("flags.title")).toBeUndefined();
  });

  it("toggles the picked colour on the mail", () => {
    const picked: MailFlag[] = [];
    render({ onToggleFlag: (_mail, flag) => picked.push(flag) });
    openFlagSubmenu();
    act(() => flagItem("blue")!.click());
    expect(picked).toEqual(["blue"]);
  });

  it("offers 'clear all' only once the mail carries a flag", () => {
    render({ onToggleFlag: noop, onClearFlags: noop });
    openFlagSubmenu();
    expect(item("flags.clearAll")).toBeUndefined();

    render({ mail: makeMail({ flags: ["red"] }), onToggleFlag: noop, onClearFlags: noop });
    openFlagSubmenu();
    expect(item("flags.clearAll")).toBeTruthy();
  });

  it("sets a colour on a mixed selection and clears one they all share", () => {
    const calls: [MailFlag, string][] = [];
    render({
      selectedCount: 2,
      onBulkAction: noop,
      onBulkFlag: (flag, action) => calls.push([flag, action]),
      selectedFlags: [["red"], ["red", "blue"]],
    });
    openFlagSubmenu();
    act(() => flagItem("red")!.click());
    act(() => flagItem("blue")!.click());
    expect(calls).toEqual([["red", "clear"], ["blue", "set"]]);
  });
});

describe("MailContextMenu move to folder", () => {
  const FOLDERS = [folder("f-sent", "Sent", "sent"), folder("f-proj", "Projekte")];

  it("has no move entry without targets, so an account still loading shows nothing", () => {
    render({ onMove: noop, moveFolders: [] });
    expect(item("rules.moveToFolder")).toBeUndefined();
  });

  it("names the account the folders belong to", () => {
    render({ onMove: noop, moveFolders: FOLDERS, moveAccountLabel: "max@firma.de" });
    openSubmenu("rules.moveToFolder");
    expect(document.body.textContent).toContain("max@firma.de");
  });

  it("labels a standard folder the way the sidebar does and keeps custom names", () => {
    render({ onMove: noop, moveFolders: FOLDERS, moveAccountLabel: "max@firma.de" });
    openSubmenu("rules.moveToFolder");
    // "sent" resolves through folder.types.*; "Projekte" has no type and stays put.
    expect(item("folder.types.sent")).toBeTruthy();
    expect(Array.from(document.querySelectorAll("button")).some((b) => b.textContent?.trim() === "Projekte")).toBe(true);
  });

  it("reports the picked folder together with the mail it belongs to", () => {
    const moved: [string, string][] = [];
    render({
      mail: makeMail({ id: "m9", account_id: "a2" }),
      onMove: (m, dest) => moved.push([m.id, dest]),
      moveFolders: FOLDERS,
    });
    openSubmenu("rules.moveToFolder");
    act(() => item("folder.types.sent")!.click());
    expect(moved).toEqual([["m9", "f-sent"]]);
  });

  it("offers the same submenu for a selection", () => {
    const moved: string[] = [];
    render({
      selectedCount: 2,
      onBulkAction: noop,
      onBulkMove: (dest: string) => moved.push(dest),
      moveFolders: FOLDERS,
      moveAccountLabel: "max@firma.de",
    });
    openSubmenu("rules.moveToFolder");
    expect(document.body.textContent).toContain("max@firma.de");
    act(() => item("folder.types.sent")!.click());
    expect(moved).toEqual(["f-sent"]);
  });
});
