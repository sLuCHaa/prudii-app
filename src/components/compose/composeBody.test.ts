import { describe, it, expect, afterEach } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { closeHistory } from "@tiptap/pm/history";
import Link from "@tiptap/extension-link";
import TiptapImage from "@tiptap/extension-image";
import { accountSignatureHtml, hasOwnText, localImageSources, replaceImageSources, setComposeBody, setSignature } from "./composeBody";
import { SignatureNode } from "./signatureNode";
import { cleanPastedHtml } from "../editor/pasteCleanup";
import { DESIGNED_SIGNATURE } from "../../lib/signatureFixture";
import { parseMailtoUrl } from "../../lib/mailtoParser";
import { plainTextParagraph } from "../../lib/sanitize";

const SIGNED = `<p></p><div data-type="signature"><p><strong>Anna</strong></p><p><a href="https://www.studio-halde.de">www.studio-halde.de</a></p></div>`;

let editor: Editor;

afterEach(() => editor?.destroy());

const signatures = (e: Editor) => {
  const found: string[] = [];
  e.state.doc.descendants((node) => {
    if (node.type.name === "signature") found.push(String(node.attrs.html));
  });
  return found;
};

function make(element?: HTMLElement) {
  editor = new Editor({
    ...(element ? { element } : {}),
    extensions: [StarterKit.configure({ heading: false, link: false, underline: false }), Link.configure({ openOnClick: false }), TiptapImage.configure({ inline: true, allowBase64: true }), SignatureNode],
    editorProps: { transformPastedHTML: cleanPastedHtml },
    content: "",
  });
  return editor;
}

describe("plain text bodies", () => {
  const PAYLOAD = `<div data-type="signature"><p>a</p><style>p{color:red}</style><form action="https://evil.example/x"><button>Go</button></form></div>`;

  it("keeps markup in a mailto body as text", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const e = make(host);
      const { body } = parseMailtoUrl(`mailto:anna@example.com?body=${encodeURIComponent(PAYLOAD)}`);
      setComposeBody(e, plainTextParagraph(body));
      expect(host.querySelector("style, form, button, [data-type=\"signature\"]")).toBeNull();
      expect(signatures(e)).toEqual([]);
      expect(e.getText()).toBe(PAYLOAD);
    } finally {
      host.remove();
    }
  });

  it("keeps markup in an AI reply as text next to the real signature", () => {
    const e = make();
    setComposeBody(e, `${plainTextParagraph(`Gern!
${PAYLOAD}`)}<div data-type="signature"><p>Anna</p></div>`);
    expect(signatures(e)).toEqual(["<p>Anna</p>"]);
    expect(e.getText()).toContain(PAYLOAD);
  });
});

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
    expect(e.getHTML()).toContain("www.studio-halde.de");
  });

  it("puts typed text above the signature", () => {
    const e = make();
    setComposeBody(e, SIGNED);
    e.commands.insertContent("Hallo");
    expect(e.getHTML().indexOf("Hallo")).toBeLessThan(e.getHTML().indexOf("data-type=\"signature\""));
  });

  it("puts an empty line above a signature the body begins with", () => {
    const e = make();
    setComposeBody(e, `<div data-type="signature"><p>Gruß</p></div>`);
    expect(e.getHTML()).toMatch(/^<p><\/p><div data-type="signature"><p>Gruß<\/p><\/div>/);
    expect(e.state.selection.empty).toBe(true);
    expect(e.state.selection.$from.parent.type.name).toBe("paragraph");
    e.commands.focus("start");
    e.view.dispatch(e.state.tr.insertText("H"));
    expect(e.getHTML()).toMatch(/^<p>H<\/p><div data-type="signature"><p>Gruß<\/p><\/div>/);
  });
});

describe("draft images", () => {
  const PIXEL = "data:image/png;base64,iVBORw0KGgo=";
  const SHOT = "file:///C:/mail/shot.png";
  const OTHER = "file:///C:/mail/other.png";
  const DRAFT = `<p>Hi<img src="${SHOT}" width="320"><img src="${SHOT}"><img src="${OTHER}"></p><div data-type="signature"><p>Anna</p></div>`;

  it("lists each local image once", () => {
    const e = make();
    setComposeBody(e, `<p><img src="${PIXEL}"></p>${DRAFT}`);
    expect(localImageSources(e)).toEqual([SHOT, OTHER]);
  });

  it("swaps the sources in place and keeps what was typed meanwhile", () => {
    const e = make();
    setComposeBody(e, DRAFT);
    e.commands.insertContent("Hallo ");
    replaceImageSources(e, new Map([[SHOT, PIXEL], [OTHER, PIXEL]]));
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
    expect(localImageSources(e)).toEqual([OTHER]);
  });
});

describe("setSignature", () => {
  const A = `<div data-type="signature"><p>Anna</p></div>`;
  const B = `<div data-type="signature"><table><tr><td>Bernd</td></tr></table></div>`;
  const count = (e: Editor) => e.getHTML().match(/data-type="signature"/g)?.length ?? 0;

  it("replaces the block as a whole and leaves the text before it alone", () => {
    const e = make();
    setComposeBody(e, `<p>Hallo</p>${A}`);
    setSignature(e, B);
    expect(count(e)).toBe(1);
    expect(e.getHTML()).toContain("Bernd");
    expect(e.getHTML()).not.toContain("Anna");
    expect(e.getHTML()).toMatch(/^<p>Hallo<\/p>/);
  });

  it("accepts the inner html as well and sanitizes it", () => {
    const e = make();
    setComposeBody(e, `<p>Hallo</p>${A}`);
    setSignature(e, `<p onclick="x()">Bernd</p><script>alert(1)</script>`);
    expect(e.getHTML()).toContain("Bernd");
    expect(e.getHTML()).not.toContain("onclick");
    expect(e.getHTML()).not.toContain("script");
  });

  it("removes the block for null", () => {
    const e = make();
    setComposeBody(e, `<p>Hallo</p>${A}`);
    setSignature(e, null);
    expect(count(e)).toBe(0);
    expect(e.getHTML()).toContain("Hallo");
  });

  it("appends the block when there is none", () => {
    const e = make();
    setComposeBody(e, `<p>Hallo</p>`);
    setSignature(e, B);
    expect(count(e)).toBe(1);
    expect(e.getHTML().indexOf("Hallo")).toBeLessThan(e.getHTML().indexOf("Bernd"));
  });

  it("removes the block for a signature without visible content", () => {
    const e = make();
    setComposeBody(e, `<p>Hallo</p>${A}`);
    setSignature(e, `<div data-type="signature"><div><br></div></div>`);
    expect(count(e)).toBe(0);
    setSignature(e, `<div data-type="signature"><p>&nbsp;</p></div>`);
    expect(count(e)).toBe(0);
  });

  it("keeps only the last of several blocks", () => {
    const e = make();
    setComposeBody(e, `<p>Hallo</p>${A}<p>PS</p>${A}`);
    setSignature(e, B);
    expect(signatures(e)).toEqual(["<table><tbody><tr><td>Bernd</td></tr></tbody></table>"]);
    expect(e.getHTML().indexOf("PS")).toBeLessThan(e.getHTML().indexOf("Bernd"));
  });

  it("finds a block nested in a quote", () => {
    const e = make();
    setComposeBody(e, `<p>Hallo</p><blockquote>${A}</blockquote>`);
    setSignature(e, B);
    expect(count(e)).toBe(1);
    expect(e.getHTML()).toContain(`<blockquote><div data-type="signature"><table>`);
    setSignature(e, null);
    expect(count(e)).toBe(0);
    expect(e.getHTML()).not.toContain("blockquote");
  });

  it("does nothing for null without a block", () => {
    const e = make();
    setComposeBody(e, `<p>Hallo</p>`);
    setSignature(e, null);
    expect(e.getHTML()).toBe("<p>Hallo</p>");
  });

  it("keeps the cursor and is one undo step", () => {
    const e = make();
    setComposeBody(e, `<p>Hallo</p>${A}`);
    e.view.dispatch(closeHistory(e.state.tr));
    e.commands.setTextSelection(3);
    e.view.dispatch(closeHistory(e.state.tr));
    setSignature(e, B);
    expect(e.state.selection.from).toBe(3);
    e.commands.undo();
    expect(e.getHTML()).toContain("Anna");
  });
});

describe("signature images", () => {
  const LOGO = "file:///C:/x/logo.png";
  const DATA = "data:image/png;base64,AAA=";

  it("lists local images inside the signature", () => {
    const e = make();
    setComposeBody(e, `<p>Hi</p><div data-type="signature"><p><img src="${LOGO}"></p></div>`);
    expect(localImageSources(e)).toEqual([LOGO]);
  });

  it("lists single-quoted sources too", () => {
    const e = make();
    setComposeBody(e, `<p>Hi</p><div data-type="signature"><p><img src='${LOGO}'></p></div>`);
    expect(localImageSources(e)).toEqual([LOGO]);
  });

  it("handles an apostrophe or an ampersand in the path", () => {
    const e = make();
    const quoted = "file:///C:/Users/O'Brien/logo.png";
    const amp = "file:///C:/a&b/logo.png";
    setComposeBody(e, `<p>Hi</p><div data-type="signature"><p><img src="${quoted}"><img src="${amp.replace("&", "&amp;")}"></p></div>`);
    expect(localImageSources(e)).toEqual([quoted, amp]);
    replaceImageSources(e, new Map([[quoted, DATA], [amp, "data:image/png;base64,BBB="]]));
    expect(localImageSources(e)).toEqual([]);
    expect(e.getHTML()).not.toContain("file:");
    expect(e.getHTML()).toContain('src="data:image/png;base64,BBB="');
  });

  it("swaps them in the html attribute without an undo step", () => {
    const e = make();
    setComposeBody(e, `<p>Hi</p><div data-type="signature"><p><img src="${LOGO}"></p></div>`);
    e.view.dispatch(closeHistory(e.state.tr));
    e.commands.insertContentAt(1, "Hallo ");
    replaceImageSources(e, new Map([[LOGO, DATA]]));
    expect(e.getHTML()).toContain(`src="${DATA}"`);
    expect(e.getHTML()).not.toContain("file://");
    expect(localImageSources(e)).toEqual([]);
    e.commands.undo();
    expect(e.getHTML()).not.toContain("Hallo");
    expect(e.getHTML()).toContain(`src="${DATA}"`);
  });
});

describe("accountSignatureHtml", () => {
  const account = { signature_html: "", signature_text: "", signature_on_compose: true, signature_on_reply: false };

  it("wraps the stored html in the signature block", () => {
    expect(accountSignatureHtml({ ...account, signature_html: "<p>Anna</p>" }, false)).toBe(`<div data-type="signature"><p>Anna</p></div>`);
  });

  it("falls back to the plain text, escaped", () => {
    expect(accountSignatureHtml({ ...account, signature_text: "Anna\n<Studio>" }, false)).toBe(`<div data-type="signature"><p>Anna<br>&lt;Studio&gt;</p></div>`);
  });

  it("drops a style sheet and the document around a pasted signature", () => {
    const html = accountSignatureHtml({ ...account, signature_html: "<html><head><style>p{color:red}</style></head><body><p>Anna</p></body></html>" }, false);
    expect(html).toBe(`<div data-type="signature"><p>Anna</p></div>`);
  });

  it("gives no block for a cleared signature", () => {
    expect(accountSignatureHtml({ ...account, signature_html: "<div><br></div>" }, false)).toBe("");
    expect(accountSignatureHtml({ ...account, signature_text: " \n " }, false)).toBe("");
  });

  it("follows the compose and reply switches", () => {
    const signed = { ...account, signature_html: "<p>Anna</p>" };
    expect(accountSignatureHtml(signed, true)).toBe("");
    expect(accountSignatureHtml({ ...signed, signature_on_compose: false, signature_on_reply: true }, false)).toBe("");
    expect(accountSignatureHtml({ ...signed, signature_on_reply: true }, true)).toContain("Anna");
  });
});

describe("pasting signatures", () => {
  const paste = (e: Editor, html: string) => {
    (globalThis as { ClipboardEvent?: unknown }).ClipboardEvent ??= class extends Event {};
    (e.view as unknown as { pasteHTML: (html: string) => boolean }).pasteHTML(html);
  };

  it("turns a signature pasted from another mail into editable text", () => {
    const e = make();
    setComposeBody(e, `<p></p><div data-type="signature"><p>Anna</p></div>`);
    paste(e, `<div data-type="signature"><p>Gruß</p></div>`);
    expect(signatures(e)).toEqual(["<p>Anna</p>"]);
    expect(e.getText()).toContain("Gruß");
  });

  it("keeps a block copied inside the editor as it was designed", () => {
    const e = make();
    setComposeBody(e, `<p>Hallo</p><div data-type="signature">${DESIGNED_SIGNATURE}</div>`);
    let pos = -1;
    e.state.doc.forEach((node, offset) => {
      if (node.type.name === "signature") pos = offset;
    });
    e.commands.setNodeSelection(pos);
    const { dom } = (e.view as unknown as { serializeForClipboard: (s: unknown) => { dom: HTMLElement } }).serializeForClipboard(e.state.selection.content());
    e.commands.setTextSelection(1);
    paste(e, dom.innerHTML);
    expect(signatures(e)).toEqual([DESIGNED_SIGNATURE, DESIGNED_SIGNATURE]);
  });
});
