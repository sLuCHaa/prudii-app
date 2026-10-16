import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { LinkClickGuard, selectLinkForEditing } from "./linkEditing";

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
    extensions: [StarterKit.configure({ heading: false, link: false, underline: false }), Link.configure({ openOnClick: false }), LinkClickGuard],
    content: html,
  });
  return editor;
}

const LINKED = '<p>hallo <a href="https://a.de">welt</a> ende</p>';

describe("LinkClickGuard", () => {
  it("keeps a click on a link inside the editor from opening it", async () => {
    const e = make(LINKED);
    await new Promise((r) => setTimeout(r, 0));
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
