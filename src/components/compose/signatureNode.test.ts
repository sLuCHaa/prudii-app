import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { SignatureNode } from "./signatureNode";
import { addSignatureDivider } from "../../lib/outgoingHtml";

let editor: Editor;

afterEach(() => editor?.destroy());

function make(content: string) {
  editor = new Editor({
    extensions: [StarterKit.configure({ heading: false, link: false, underline: false }), SignatureNode],
    content,
  });
  return editor;
}

describe("SignatureNode", () => {
  it("opens the signature with the -- delimiter in the plain-text part", () => {
    const e = make(`<p>Hallo</p><div data-type="signature"><p><strong>Patrick</strong><br>Messtex</p></div>`);
    expect(e.getText({ blockSeparator: "\n\n" })).toBe("Hallo\n\n-- \nPatrick\nMesstex");
  });

  it("adds no delimiter for an emptied signature", () => {
    const e = make(`<p>Hallo</p><div data-type="signature"><p></p></div>`);
    expect(e.getText({ blockSeparator: "\n\n" })).not.toContain("--");
  });

  it("drops the sent divider when a draft goes back into the editor", () => {
    const signed = `<p>Hallo</p><div data-type="signature"><p>Patrick</p></div>`;
    const e = make(addSignatureDivider(signed, "#10b981"));
    expect(e.getHTML()).toBe(signed);
  });
});
