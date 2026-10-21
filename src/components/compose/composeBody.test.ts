import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import TiptapImage from "@tiptap/extension-image";
import { hasOwnText, localImageSources, replaceImageSources, setComposeBody } from "./composeBody";
import { SignatureNode } from "./signatureNode";

const SIGNED = `<p></p><div data-type="signature"><p><strong>Patrick</strong></p><p><a href="https://www.messtex.de">www.messtex.de</a></p></div>`;

let editor: Editor;

afterEach(() => editor?.destroy());

function make() {
  editor = new Editor({
    extensions: [StarterKit.configure({ heading: false, link: false, underline: false }), Link.configure({ openOnClick: false }), TiptapImage.configure({ inline: true, allowBase64: true }), SignatureNode],
    content: "",
  });
  return editor;
}

describe("hasOwnText", () => {
  it("does not count the signature or empty lines", () => {
    const e = make();
    setComposeBody(e, SIGNED);
    expect(hasOwnText(e)).toBe(false);
  });

  it("counts text written above the signature", () => {
    const e = make();
    setComposeBody(e, `<p>Hallo Anna</p>${SIGNED}`);
    expect(hasOwnText(e)).toBe(true);
  });

  it("counts an image the user put in", () => {
    const e = make();
    setComposeBody(e, `<p><img src="data:image/png;base64,iVBORw0KGgo="></p>${SIGNED}`);
    expect(hasOwnText(e)).toBe(true);
  });
});

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

describe("draft images", () => {
  const PIXEL = "data:image/png;base64,iVBORw0KGgo=";
  const LOGO = "file://C:/mail/logo.png";
  const SHOT = "file:///C:/mail/shot.png";
  const DRAFT = `<p>Hi<img src="${SHOT}" width="320"><img src="${SHOT}"></p><div data-type="signature"><p><img src="${LOGO}"></p></div>`;

  it("lists each local image once", () => {
    const e = make();
    setComposeBody(e, `<p><img src="${PIXEL}"></p>${DRAFT}`);
    expect(localImageSources(e)).toEqual([SHOT, LOGO]);
  });

  it("swaps the sources in place and keeps what was typed meanwhile", () => {
    const e = make();
    setComposeBody(e, DRAFT);
    e.commands.insertContent("Hallo ");
    replaceImageSources(e, new Map([[SHOT, PIXEL], [LOGO, PIXEL]]));
    const html = e.getHTML();
    expect(html).not.toContain("file://");
    expect(html).toContain("Hallo");
    expect(html).toContain(`src="${PIXEL}" width="320"`);
    expect(html.match(/data:image\/png/g)).toHaveLength(3);
    e.commands.undo();
    expect(e.getHTML()).not.toContain("Hallo");
    expect(e.getHTML()).not.toContain("file://");
  });

  it("leaves images it has no data for alone", () => {
    const e = make();
    setComposeBody(e, DRAFT);
    replaceImageSources(e, new Map([[SHOT, PIXEL]]));
    expect(localImageSources(e)).toEqual([LOGO]);
  });
});
