import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { SignatureNode, signatureText } from "./signatureNode";
import { addSignatureDivider } from "../../lib/outgoingHtml";
import { DESIGNED_SIGNATURE } from "../../lib/signatureFixture";

let editor: Editor;

afterEach(() => editor?.destroy());

function make(content: string, element?: HTMLElement) {
  editor = new Editor({
    element,
    extensions: [StarterKit.configure({ heading: false, link: false, underline: false }), SignatureNode],
    content,
  });
  return editor;
}

const sig = (inner: string) => `<div data-type="signature">${inner}</div>`;
const rendered = (host: HTMLElement) => (host.querySelector('[data-type="signature"]') as HTMLElement).shadowRoot!;
const EXPECTED_TEXT =
  "Anna Weber\nFull Stack & Mobile Developer\nTelefon: +49 30 1234567\nE-Mail: anna.weber@studio-halde.de\nStudio Halde\nHafenweg 3\n20457 Hamburg\nwww.studio-halde.de";

describe("SignatureNode", () => {
  it("keeps a designed signature byte-identical", () => {
    const e = make(`<p>Hallo</p>${sig(DESIGNED_SIGNATURE)}`);
    expect(e.getHTML()).toBe(`<p>Hallo</p>${sig(DESIGNED_SIGNATURE)}`);
  });

  it("drops the sent divider when a draft goes back into the editor", () => {
    const signed = `<p>Hallo</p>${sig(DESIGNED_SIGNATURE)}`;
    const e = make(addSignatureDivider(signed, "#10b981"));
    expect(e.getHTML()).toBe(signed);
  });

  it("opens the signature with the -- delimiter in the plain-text part", () => {
    const e = make(`<p>Hallo</p>${sig(DESIGNED_SIGNATURE)}`);
    expect(e.getText({ blockSeparator: "\n\n" })).toBe(`Hallo\n\n-- \n${EXPECTED_TEXT}`);
  });

  it("exposes the text part without the delimiter", () => {
    expect(signatureText(DESIGNED_SIGNATURE)).toBe(EXPECTED_TEXT);
    expect(signatureText("<p></p>")).toBe("");
  });

  it("separates table cells", () => {
    expect(signatureText("<table><tr><td>Tel</td><td>123</td></tr></table>")).toBe("Tel 123");
  });

  it("sanitizes the attribute again when rendering the block", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const e = make("<p>x</p>", host);
      e.commands.insertContentAt(2, { type: "signature", attrs: { html: '<p onclick="x()">Hi</p>' } });
      const shown = rendered(host);
      expect(shown.innerHTML).toContain("Hi");
      expect(shown.innerHTML).not.toContain("onclick");
    } finally {
      host.remove();
    }
  });

  it("renders a stored signature without its style sheet or form", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      const e = make(sig(`<p>Gruß</p><style>p{color:red}</style><form action="https://evil.example/x"><button>Go</button></form>`), host);
      const shown = rendered(host);
      expect(shown.querySelector("style, form, button")).toBeNull();
      expect(shown.textContent).toContain("Gruß");
      expect(e.getHTML()).not.toMatch(/<style|<form|<button/);
    } finally {
      host.remove();
    }
  });

  it("adds no delimiter for an emptied signature", () => {
    const e = make(`<p>Hallo</p>${sig("<p></p>")}`);
    expect(e.getText({ blockSeparator: "\n\n" })).not.toContain("--");
  });

  it("strips scripts and event handlers", () => {
    const e = make(sig(`<p onclick="x()">Gruß</p><script>alert(1)</script>`));
    const html = e.getHTML();
    expect(html).not.toContain("onclick");
    expect(html).not.toContain("script");
    expect(html).toContain("Gruß");
  });

  it("swallows clicks on links in the rendered block", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      make(sig(DESIGNED_SIGNATURE), host);
      const block = host.querySelector('[data-type="signature"]') as HTMLElement;
      expect(block.getAttribute("contenteditable")).toBe("false");
      for (const type of ["click", "auxclick"]) {
        const event = new MouseEvent(type, { bubbles: true, composed: true, cancelable: true, button: type === "click" ? 0 : 1 });
        rendered(host).querySelector("a")!.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
      }
    } finally {
      host.remove();
    }
  });

  it("renders the signature apart from the editor's own styles", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    try {
      make(sig(DESIGNED_SIGNATURE), host);
      const block = host.querySelector('[data-type="signature"]') as HTMLElement;
      expect(block.childNodes).toHaveLength(0);
      expect(block.shadowRoot!.innerHTML).toBe(DESIGNED_SIGNATURE);
    } finally {
      host.remove();
    }
  });

  it("gives the block the mail's line height", () => {
    const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
    expect(css).toMatch(/\.compose-editor \.tiptap \[data-type="signature"\] \{[^}]*line-height: 1\.5;/);
  });

  it("keeps whatever the signature paints inside its block", () => {
    const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
    expect(css).toMatch(/\.compose-editor \.tiptap \[data-type="signature"\] \{[^}]*contain: paint;/);
  });

  it("lets a signature wider than the editor scroll instead of being cut off", () => {
    const css = readFileSync(resolve(__dirname, "../../index.css"), "utf8");
    expect(css).toMatch(/\.compose-editor \.tiptap \[data-type="signature"\] \{[^}]*overflow-x: auto;/);
  });

  it("creates no block for a signature without visible content", () => {
    for (const inner of ["<div><br></div>", "<p>&nbsp;</p>", "<style>p{color:red}</style>"]) {
      const e = make(`<p>Hallo</p>${sig(inner)}`);
      let blocks = 0;
      e.state.doc.descendants((node) => {
        if (node.type.name === "signature") blocks++;
      });
      expect(blocks).toBe(0);
      expect(e.getHTML()).not.toContain("data-type");
      expect(e.getText()).toContain("Hallo");
      e.destroy();
    }
  });

  it("still creates a block for a signature that is only a logo", () => {
    const e = make(`<p>Hallo</p>${sig('<p><img src="data:image/png;base64,iVBORw0KGgo="></p>')}`);
    expect(e.getHTML()).toContain('data-type="signature"');
  });

  it("serialises the block sanitized and away from the live document", () => {
    const e = make("<p>x</p>");
    e.commands.insertContentAt(3, { type: "signature", attrs: { html: '<p onclick="x()">Hi</p><img src="https://example.com/l.png">' } });
    expect(e.getHTML()).toContain("<p>Hi</p>");
    expect(e.getHTML()).not.toContain("onclick");
    let node = e.state.doc.firstChild!;
    e.state.doc.forEach((child) => {
      if (child.type.name === "signature") node = child;
    });
    const dom = e.schema.nodes.signature.spec.toDOM!(node) as HTMLElement;
    expect(dom.ownerDocument).not.toBe(document);
  });
});
