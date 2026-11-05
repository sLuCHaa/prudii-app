import { describe, it, expect } from "vitest";
import { splitSignature } from "./signatureFold";
import { visibleText } from "./quotedHistory";

const text = (html: string) => visibleText(new DOMParser().parseFromString(html, "text/html").body).replace(/\s+/g, " ").trim();

const SIGNATURE = "<p>Anna Weber</p><p>Studio Halde</p><img src=\"https://studio-halde.example/logo.png\" width=\"120\" height=\"40\">";

describe("splitSignature", () => {
  it.each([
    ["Prudii", `<div data-type="signature">${SIGNATURE}</div>`],
    ["Gmail", `<span class="gmail_signature_prefix">-- </span><br><div class="gmail_signature" data-smartmail="gmail_signature">${SIGNATURE}</div>`],
    ["Outlook", `<div name=messageSignatureSection>${SIGNATURE}</div>`],
    ["OWA", `<div id="Signature">${SIGNATURE}</div>`],
    ["OWA reply", `<div id="x_Signature">${SIGNATURE}</div>`],
    ["Thunderbird", `<div class="moz-signature">-- <br>${SIGNATURE}</div>`],
  ])("cuts a trailing %s signature off the text", (_, signature) => {
    const split = splitSignature(`<p>Bitte bis Freitag einplanen.</p>${signature}`)!;
    expect(text(split.body)).toBe("Bitte bis Freitag einplanen.");
    expect(text(split.signature)).toContain("Anna Weber Studio Halde");
  });

  it("still counts blank lines and a tracking pixel after it as the end", () => {
    const split = splitSignature(`<p>Danke!</p><div id="Signature">${SIGNATURE}</div><p>&nbsp;</p><br><img src="https://t.example/p.gif" width="1" height="1">`);
    expect(split).not.toBeNull();
    expect(text(split!.body)).toBe("Danke!");
  });

  it("drops the blank lines between the text and the signature", () => {
    const split = splitSignature(`<div><p>Danke!</p><p>&nbsp;</p><br></div><p>&nbsp;</p><div id="Signature">${SIGNATURE}</div><style>.x{color:red}</style>`)!;
    const body = new DOMParser().parseFromString(split.body, "text/html").body;
    expect(body.innerHTML).toBe("<div><p>Danke!</p></div><style>.x{color:red}</style>");
  });

  it("leaves a signature with text after it in place", () => {
    expect(splitSignature(`<p>Danke!</p><div id="Signature">${SIGNATURE}</div><blockquote><p>Passt Freitag?</p></blockquote>`)).toBeNull();
  });

  it("leaves a mail that is nothing but its signature alone", () => {
    expect(splitSignature(`<div data-type="signature">${SIGNATURE}</div>`)).toBeNull();
  });

  it("folds the outermost of nested signature markers", () => {
    const split = splitSignature(`<p>Danke!</p><div name="messageSignatureSection"><div id="Signature">${SIGNATURE}</div></div>`)!;
    expect(text(split.body)).toBe("Danke!");
    expect(split.signature).toContain("messageSignatureSection");
  });

  it("carries the mail's styles into the signature", () => {
    const split = splitSignature(`<html><head><style>.brand{color:#0a7}</style></head><body><p>Danke!</p><div id="Signature"><p class="brand">Anna Weber</p></div></body></html>`)!;
    expect(split.signature).toContain(".brand{color:#0a7}");
    expect(split.body).toContain(".brand{color:#0a7}");
  });

  it("returns null without a signature marker", () => {
    expect(splitSignature("<p>Danke!</p><p>Anna</p>")).toBeNull();
    expect(splitSignature("")).toBeNull();
  });
});
