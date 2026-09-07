import { describe, it, expect } from "vitest";
import { resolveGlobalShortcut, formatShortcut, MENU_ACTIONS } from "./shortcuts";

function key(k: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) {
  return { key: k, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt };
}

describe("resolveGlobalShortcut", () => {
  it("keeps the existing bare-key actions on every platform", () => {
    for (const isMac of [false, true]) {
      expect(resolveGlobalShortcut(key("c"), isMac)).toBe("newMessage");
      expect(resolveGlobalShortcut(key("C", { shift: true }), isMac)).toBeNull();
      expect(resolveGlobalShortcut(key("/"), isMac)).toBe("search");
      expect(resolveGlobalShortcut(key("?", { shift: true }), isMac)).toBe("help");
      expect(resolveGlobalShortcut(key("A", { ctrl: true, shift: true }), isMac)).toBe("addAccount");
      expect(resolveGlobalShortcut(key("f", { ctrl: true }), isMac)).toBe("search");
    }
  });

  it("adds the desktop conventions on Windows/Linux", () => {
    expect(resolveGlobalShortcut(key("n", { ctrl: true }), false)).toBe("newMessage");
    expect(resolveGlobalShortcut(key(",", { ctrl: true }), false)).toBe("settings");
    expect(resolveGlobalShortcut(key("r", { ctrl: true }), false)).toBe("reply");
    expect(resolveGlobalShortcut(key("R", { ctrl: true, shift: true }), false)).toBe("replyAll");
    expect(resolveGlobalShortcut(key("F", { ctrl: true, shift: true }), false)).toBe("forward");
    expect(resolveGlobalShortcut(key("N", { ctrl: true, shift: true }), false)).toBe("syncAll");
    expect(resolveGlobalShortcut(key("F11"), false)).toBe("toggleFullscreen");
  });

  it("opens tasks with Mod+Shift+T and quick-adds one with bare t, on every platform", () => {
    expect(resolveGlobalShortcut(key("T", { ctrl: true, shift: true }), false)).toBe("openTasks");
    expect(resolveGlobalShortcut(key("T", { meta: true, shift: true }), true)).toBe("openTasks");
    expect(resolveGlobalShortcut(key("t"), false)).toBe("newTask");
    expect(resolveGlobalShortcut(key("t"), true)).toBe("newTask");
  });

  it("leaves menu-bar accelerators to the native menu on macOS", () => {
    expect(resolveGlobalShortcut(key("n", { meta: true }), true)).toBeNull();
    expect(resolveGlobalShortcut(key(",", { meta: true }), true)).toBeNull();
    expect(resolveGlobalShortcut(key("r", { meta: true }), true)).toBeNull();
    expect(resolveGlobalShortcut(key("R", { meta: true, shift: true }), true)).toBeNull();
    expect(resolveGlobalShortcut(key("F", { meta: true, shift: true }), true)).toBeNull();
    expect(resolveGlobalShortcut(key("N", { meta: true, shift: true }), true)).toBeNull();
    expect(resolveGlobalShortcut(key("F11"), true)).toBeNull();
  });

  it("ignores alt combinations and unknown keys", () => {
    expect(resolveGlobalShortcut(key("n", { ctrl: true, alt: true }), false)).toBeNull();
    expect(resolveGlobalShortcut(key("x", { ctrl: true }), false)).toBeNull();
    expect(resolveGlobalShortcut(key("b", { ctrl: true }), false)).toBeNull();
  });
});

describe("MENU_ACTIONS", () => {
  it("maps every native menu id from lib.rs", () => {
    expect(MENU_ACTIONS["menu:new_message"]).toBe("newMessage");
    expect(MENU_ACTIONS["menu:settings"]).toBe("settings");
    expect(MENU_ACTIONS["menu:sync_all"]).toBe("syncAll");
    expect(MENU_ACTIONS["menu:reply"]).toBe("reply");
    expect(MENU_ACTIONS["menu:reply_all"]).toBe("replyAll");
    expect(MENU_ACTIONS["menu:forward"]).toBe("forward");
  });
});

describe("formatShortcut", () => {
  it("spells modifiers out on Windows/Linux", () => {
    expect(formatShortcut("Mod+Shift+A", false)).toBe("Ctrl+Shift+A");
    expect(formatShortcut("Mod+,", false)).toBe("Ctrl+,");
    expect(formatShortcut("j / k", false)).toBe("j / k");
    expect(formatShortcut("F11", false)).toBe("F11");
  });

  it("uses Apple glyphs in Apple order on macOS", () => {
    expect(formatShortcut("Mod+Shift+A", true)).toBe("⇧⌘A");
    expect(formatShortcut("Mod+,", true)).toBe("⌘,");
    expect(formatShortcut("Mod+Enter", true)).toBe("⌘↩");
    expect(formatShortcut("j / k", true)).toBe("j / k");
  });
});
