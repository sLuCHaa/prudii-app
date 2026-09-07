import { describe, it, expect } from "vitest";
import { isBrowserChromeKey, installBrowserKeyGuard } from "./browserKeyGuard";

function key(k: string, mods: Partial<{ ctrl: boolean; meta: boolean; shift: boolean; alt: boolean }> = {}) {
  return { key: k, ctrlKey: !!mods.ctrl, metaKey: !!mods.meta, shiftKey: !!mods.shift, altKey: !!mods.alt };
}

describe("isBrowserChromeKey", () => {
  it("blocks reload keys everywhere", () => {
    expect(isBrowserChromeKey(key("F5"))).toBe(true);
    expect(isBrowserChromeKey(key("r", { ctrl: true }))).toBe(true);
    expect(isBrowserChromeKey(key("R", { ctrl: true, shift: true }))).toBe(true);
    expect(isBrowserChromeKey(key("r", { meta: true }))).toBe(true);
    expect(isBrowserChromeKey(key("r", { ctrl: true }), { inEditable: true })).toBe(true);
  });

  it("blocks print, find bar, caret browsing and zoom", () => {
    expect(isBrowserChromeKey(key("p", { ctrl: true }))).toBe(true);
    expect(isBrowserChromeKey(key("f", { ctrl: true }))).toBe(true);
    expect(isBrowserChromeKey(key("g", { ctrl: true }))).toBe(true);
    expect(isBrowserChromeKey(key("F3"))).toBe(true);
    expect(isBrowserChromeKey(key("F7"))).toBe(true);
    expect(isBrowserChromeKey(key("+", { ctrl: true, shift: true }))).toBe(true);
    expect(isBrowserChromeKey(key("-", { ctrl: true }))).toBe(true);
    expect(isBrowserChromeKey(key("0", { ctrl: true }))).toBe(true);
  });

  it("keeps editor shortcuts inside editable fields", () => {
    expect(isBrowserChromeKey(key("u", { ctrl: true }))).toBe(true);
    expect(isBrowserChromeKey(key("u", { ctrl: true }), { inEditable: true })).toBe(false);
    expect(isBrowserChromeKey(key("ArrowLeft", { alt: true }))).toBe(true);
    expect(isBrowserChromeKey(key("ArrowLeft", { alt: true }), { inEditable: true })).toBe(false);
  });

  it("blocks devtools unless explicitly allowed", () => {
    expect(isBrowserChromeKey(key("F12"))).toBe(true);
    expect(isBrowserChromeKey(key("I", { ctrl: true, shift: true }))).toBe(true);
    expect(isBrowserChromeKey(key("F12"), { allowDevtools: true })).toBe(false);
    expect(isBrowserChromeKey(key("I", { ctrl: true, shift: true }), { allowDevtools: true })).toBe(false);
  });

  it("leaves app shortcuts and plain typing alone", () => {
    expect(isBrowserChromeKey(key("r"))).toBe(false);
    expect(isBrowserChromeKey(key("b", { ctrl: true }))).toBe(false);
    expect(isBrowserChromeKey(key("k", { ctrl: true }))).toBe(false);
    expect(isBrowserChromeKey(key("a", { ctrl: true }))).toBe(false);
    expect(isBrowserChromeKey(key("Enter", { ctrl: true }))).toBe(false);
    expect(isBrowserChromeKey(key("ArrowLeft"))).toBe(false);
    expect(isBrowserChromeKey(key("r", { ctrl: true, alt: true }))).toBe(false);
  });
});

describe("installBrowserKeyGuard", () => {
  it("prevents the default of F5 and ctrl+wheel, and uninstalls cleanly", () => {
    const uninstall = installBrowserKeyGuard(window);

    const f5 = new KeyboardEvent("keydown", { key: "F5", cancelable: true, bubbles: true });
    document.body.dispatchEvent(f5);
    expect(f5.defaultPrevented).toBe(true);

    const zoom = new WheelEvent("wheel", { ctrlKey: true, cancelable: true, bubbles: true });
    document.body.dispatchEvent(zoom);
    expect(zoom.defaultPrevented).toBe(true);

    const scroll = new WheelEvent("wheel", { cancelable: true, bubbles: true });
    document.body.dispatchEvent(scroll);
    expect(scroll.defaultPrevented).toBe(false);

    uninstall();
    const again = new KeyboardEvent("keydown", { key: "F5", cancelable: true, bubbles: true });
    document.body.dispatchEvent(again);
    expect(again.defaultPrevented).toBe(false);
  });

  it("does not block ctrl+u while typing in a contenteditable", () => {
    const uninstall = installBrowserKeyGuard(window);
    const editor = document.createElement("div");
    editor.contentEditable = "true";
    document.body.appendChild(editor);
    // jsdom does not compute isContentEditable from the attribute
    Object.defineProperty(editor, "isContentEditable", { value: true });

    const ev = new KeyboardEvent("keydown", { key: "u", ctrlKey: true, cancelable: true, bubbles: true });
    editor.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);

    editor.remove();
    uninstall();
  });
});
