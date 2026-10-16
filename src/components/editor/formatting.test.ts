import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import { clearTextFormatting } from "./formatting";

let editor: Editor;

afterEach(() => editor?.destroy());

function make(html: string) {
  editor = new Editor({
    extensions: [StarterKit.configure({ heading: false, link: false, underline: false }), Link.configure({ openOnClick: false }), Underline],
    content: html,
  });
  return editor;
}

describe("clearTextFormatting", () => {
  it("removes bold, italic, underline, strike and code but keeps links", () => {
    const e = make('<p><strong>a</strong><em>b</em><u>c</u><s>d</s><code>e</code><a href="https://a.de"><strong>f</strong></a></p>');
    e.commands.selectAll();
    clearTextFormatting(e);
    expect(e.view.dom.querySelectorAll("strong, em, u, s, code")).toHaveLength(0);
    expect(e.state.doc.textContent).toBe("abcdef");
    expect(e.view.dom.querySelector("a")?.getAttribute("href")).toBe("https://a.de");
  });

  it("only touches the selection", () => {
    const e = make("<p><strong>ab</strong></p>");
    e.commands.setTextSelection({ from: 1, to: 2 });
    clearTextFormatting(e);
    expect(e.view.dom.querySelector("strong")?.textContent).toBe("b");
  });

  it("leaves lists and quotes in place", () => {
    const e = make("<ul><li><p><strong>x</strong></p></li></ul><blockquote><p>y</p></blockquote>");
    e.commands.selectAll();
    clearTextFormatting(e);
    expect(e.view.dom.querySelectorAll("ul, blockquote")).toHaveLength(2);
    expect(e.view.dom.querySelector("strong")).toBeNull();
  });
});
