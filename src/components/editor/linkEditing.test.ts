import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { LinkActions, LinkClickGuard, applyLink, onLinkActions, selectLinkForEditing, type LinkMenuTarget } from "./linkEditing";

let editor: Editor;
let host: HTMLElement;

afterEach(() => {
  editor?.destroy();
  host?.remove();
});

function make(html: string) {
  host = document.createElement("div");
  document.body.appendChild(host);
  editor = new Editor({
    element: host,
    extensions: [StarterKit.configure({ heading: false, link: false, underline: false }), Link.configure({ openOnClick: false }), LinkClickGuard, LinkActions],
    content: html,
  });
  return editor;
}

const LINKED = '<p>hallo <a href="https://a.de">welt</a> ende</p>';

const created = () => new Promise((r) => setTimeout(r, 0));

function rightClick(el: Element) {
  const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 50 });
  el.dispatchEvent(ev);
  return ev;
}

function press(el: Element, init: KeyboardEventInit) {
  const ev = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(ev);
  return ev;
}

const noop = () => {};

function showMenu(e: Editor, seen: LinkMenuTarget[]) {
  return onLinkActions(e, { openMenu: (target) => seen.push(target), openDialog: noop, openSelectionMenu: noop });
}

function rightPress(el: Element) {
  el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 2 }));
}

function selectText(el: Element, from: number, to: number) {
  const text = el.firstChild!;
  document.getSelection()!.setBaseAndExtent(text, from, text, to);
}

function selectionMenus(e: Editor) {
  const seen: { x: number; y: number }[] = [];
  onLinkActions(e, { openMenu: noop, openDialog: noop, openSelectionMenu: (at) => seen.push(at) });
  return seen;
}

describe("LinkClickGuard", () => {
  it("keeps a click on a link inside the editor from opening it", async () => {
    const e = make(LINKED);
    await created();
    let opened = false;
    const opener = (ev: MouseEvent) => {
      if (!ev.defaultPrevented) opened = true;
    };
    window.addEventListener("click", opener);
    const a = e.view.dom.querySelector("a") as HTMLAnchorElement;
    a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
    window.removeEventListener("click", opener);
    expect(opened).toBe(false);
  });
});

describe("link context menu", () => {
  it("replaces the native menu on a link and selects the whole link", async () => {
    const e = make(LINKED);
    await created();
    const seen: LinkMenuTarget[] = [];
    showMenu(e, seen);
    const ev = rightClick(e.view.dom.querySelector("a")!);
    expect(ev.defaultPrevented).toBe(true);
    expect(seen).toEqual([{ href: "https://a.de", x: 40, y: 50 }]);
    expect([e.state.selection.from, e.state.selection.to]).toEqual([7, 11]);
  });

  it("finds the link from formatted text inside it", async () => {
    const e = make('<p>hallo <a href="https://a.de">we<strong>lt</strong></a> ende</p>');
    await created();
    const seen: LinkMenuTarget[] = [];
    showMenu(e, seen);
    rightClick(e.view.dom.querySelector("strong")!);
    expect(seen.map((s) => s.href)).toEqual(["https://a.de"]);
    expect([e.state.selection.from, e.state.selection.to]).toEqual([7, 11]);
  });

  it("keeps the native menu on plain text", async () => {
    const e = make(LINKED);
    await created();
    const seen: LinkMenuTarget[] = [];
    showMenu(e, seen);
    const ev = rightClick(e.view.dom.querySelector("p")!);
    expect(ev.defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
  });

  it("keeps the native menu when nobody shows the link menu", async () => {
    const e = make(LINKED);
    await created();
    showMenu(e, [])();
    expect(rightClick(e.view.dom.querySelector("a")!).defaultPrevented).toBe(false);
  });
});

describe("selection context menu", () => {
  beforeAll(() => {
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => null });
  });

  it("offers the app menu when right-clicking text the user selected", async () => {
    const e = make("<p>hallo welt</p>");
    await created();
    const seen = selectionMenus(e);
    const p = e.view.dom.querySelector("p")!;
    selectText(p, 6, 10);
    rightPress(p);
    const ev = rightClick(p);
    expect(ev.defaultPrevented).toBe(true);
    expect(seen).toEqual([{ x: 40, y: 50 }]);
  });

  it("keeps the native menu without a selection", async () => {
    const e = make("<p>hallo welt</p>");
    await created();
    const seen = selectionMenus(e);
    const p = e.view.dom.querySelector("p")!;
    selectText(p, 3, 3);
    rightPress(p);
    expect(rightClick(p).defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
  });

  it("keeps the native menu when the right-click itself selects a word for spelling suggestions", async () => {
    const e = make("<p>hallo welt</p>");
    await created();
    const seen = selectionMenus(e);
    const p = e.view.dom.querySelector("p")!;
    selectText(p, 3, 3);
    rightPress(p);
    selectText(p, 6, 10);
    expect(rightClick(p).defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
  });

  it("keeps the native menu when it was opened from the keyboard", async () => {
    const e = make("<p>hallo welt</p>");
    await created();
    const seen = selectionMenus(e);
    const p = e.view.dom.querySelector("p")!;
    selectText(p, 6, 10);
    expect(rightClick(p).defaultPrevented).toBe(false);
    expect(seen).toEqual([]);
  });
});

describe("link shortcut", () => {
  it("opens the link dialog on Ctrl+K and keeps the command palette out of it", async () => {
    const e = make(LINKED);
    await created();
    let dialogs = 0;
    let palette = 0;
    const onWindow = () => palette++;
    window.addEventListener("keydown", onWindow);
    onLinkActions(e, { openMenu: noop, openDialog: () => dialogs++, openSelectionMenu: noop });
    const ev = press(e.view.dom, { key: "k", ctrlKey: true });
    window.removeEventListener("keydown", onWindow);
    expect([dialogs, palette, ev.defaultPrevented]).toEqual([1, 0, true]);
  });

  it("ignores other combinations with K", async () => {
    const e = make(LINKED);
    await created();
    let dialogs = 0;
    onLinkActions(e, { openMenu: noop, openDialog: () => dialogs++, openSelectionMenu: noop });
    press(e.view.dom, { key: "K", ctrlKey: true, shiftKey: true });
    press(e.view.dom, { key: "k" });
    expect(dialogs).toBe(0);
  });

  it("leaves Ctrl+K to the app when nobody owns the link dialog", async () => {
    const e = make(LINKED);
    await created();
    onLinkActions(e, { openMenu: noop, openDialog: noop, openSelectionMenu: noop })();
    expect(press(e.view.dom, { key: "k", ctrlKey: true }).defaultPrevented).toBe(false);
  });
});

describe("applyLink", () => {
  it("inserts the address as linked text when nothing is selected", () => {
    const e = make("<p></p>");
    e.commands.insertContent({ type: "text", text: "hallo " });
    applyLink(e, "https://a.de", "");
    expect(e.state.doc.textContent).toBe("hallo https://a.de");
    expect(e.view.dom.querySelector("a")?.getAttribute("href")).toBe("https://a.de");
  });

  it("uses the given text and lets typing go on without the link", () => {
    const e = make("<p></p>");
    e.commands.insertContent({ type: "text", text: "hallo " });
    applyLink(e, "https://a.de", "Website");
    e.commands.insertContent("!");
    expect(e.state.doc.textContent).toBe("hallo Website!");
    expect(e.view.dom.querySelector("a")?.textContent).toBe("Website");
  });

  it("shows mail and phone links without their scheme", () => {
    const e = make("<p></p>");
    e.commands.setTextSelection(1);
    applyLink(e, "mailto:max@firma.de", "");
    expect(e.state.doc.textContent).toBe("max@firma.de");
  });

  it("links the selected text", () => {
    const e = make("<p>hallo welt</p>");
    e.commands.setTextSelection({ from: 7, to: 11 });
    applyLink(e, "https://a.de", "");
    expect(e.state.doc.textContent).toBe("hallo welt");
    expect(e.view.dom.querySelector("a")?.textContent).toBe("welt");
  });

  it("changes the address of the link being edited", () => {
    const e = make(LINKED);
    e.commands.setTextSelection(9);
    selectLinkForEditing(e);
    applyLink(e, "https://b.de", "");
    const links = [...e.view.dom.querySelectorAll("a")].map((a) => [a.textContent, a.getAttribute("href")]);
    expect(links).toEqual([["welt", "https://b.de"]]);
  });
});

describe("selectLinkForEditing", () => {
  it("drops the trailing space of a double-click selection and keeps the link", () => {
    const e = make(LINKED);
    e.commands.setTextSelection({ from: 7, to: 12 });
    selectLinkForEditing(e);
    expect([e.state.selection.from, e.state.selection.to]).toEqual([7, 11]);
    expect(e.isActive("link")).toBe(true);
    expect(e.getAttributes("link").href).toBe("https://a.de");
  });

  it("selects the whole link when the cursor sits inside it", () => {
    const e = make(LINKED);
    e.commands.setTextSelection(9);
    selectLinkForEditing(e);
    expect([e.state.selection.from, e.state.selection.to]).toEqual([7, 11]);
  });

  it("only trims plain text selections", () => {
    const e = make("<p>hallo welt ende</p>");
    e.commands.setTextSelection({ from: 6, to: 12 });
    selectLinkForEditing(e);
    expect([e.state.selection.from, e.state.selection.to]).toEqual([7, 11]);
    expect(e.isActive("link")).toBe(false);
  });
});
