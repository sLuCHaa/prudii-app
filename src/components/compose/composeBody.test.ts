import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import { setComposeBody } from "./composeBody";
import { SignatureNode } from "./signatureNode";

const SIGNED = `<p></p><div data-type="signature"><p><strong>Patrick</strong></p><p><a href="https://www.messtex.de">www.messtex.de</a></p></div>`;

let editor: Editor;

afterEach(() => editor?.destroy());

function make() {
  editor = new Editor({
    extensions: [StarterKit.configure({ heading: false, link: false, underline: false }), Link.configure({ openOnClick: false }), SignatureNode],
    content: "",
  });
  return editor;
}

describe("setComposeBody", () => {
  it("leaves the cursor in the empty first line, not in the signature's trailing link", () => {
    const e = make();
    setComposeBody(e, SIGNED);
    expect(e.state.selection.from).toBe(1);
    expect(e.isActive("link")).toBe(false);
    expect(e.getHTML()).toContain("www.messtex.de");
  });

  it("puts typed text above the signature", () => {
    const e = make();
    setComposeBody(e, SIGNED);
    e.commands.insertContent("Hallo");
    expect(e.getHTML().indexOf("Hallo")).toBeLessThan(e.getHTML().indexOf("data-type=\"signature\""));
  });

  it("starts at the first text position when the body begins with the signature", () => {
    const e = make();
    setComposeBody(e, `<div data-type="signature"><p>Gruß</p></div>`);
    expect(e.state.selection.empty).toBe(true);
    expect(e.state.selection.$from.parent.textContent).toBe("Gruß");
    expect(e.state.selection.$from.parentOffset).toBe(0);
  });
});
