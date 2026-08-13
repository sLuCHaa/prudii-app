import { describe, it, expect } from "vitest";
import { fillEmptyParagraphs } from "./outgoingHtml";

describe("fillEmptyParagraphs", () => {
  it("gives an empty paragraph a line break so it renders as a blank line", () => {
    expect(fillEmptyParagraphs("<p>A</p><p></p><p>B</p>")).toBe(
      "<p>A</p><p><br></p><p>B</p>"
    );
  });

  it("leaves paragraphs that have content alone", () => {
    const html = "<p>Guten Abend</p><p>Vielen Dank</p>";
    expect(fillEmptyParagraphs(html)).toBe(html);
  });

  it("treats a whitespace-only paragraph as empty", () => {
    expect(fillEmptyParagraphs("<p>   </p>")).toBe("<p><br></p>");
  });

  it("keeps the attributes of an empty paragraph", () => {
    expect(fillEmptyParagraphs('<p style="text-align: center"></p>')).toBe(
      '<p style="text-align: center"><br></p>'
    );
  });

  it("fills every empty paragraph, not just the first", () => {
    expect(fillEmptyParagraphs("<p></p><p>A</p><p></p>")).toBe(
      "<p><br></p><p>A</p><p><br></p>"
    );
  });

  it("is idempotent — an already filled paragraph is untouched", () => {
    const once = fillEmptyParagraphs("<p>A</p><p></p>");
    expect(fillEmptyParagraphs(once)).toBe(once);
  });

  it("does not disturb a signature or its embedded image", () => {
    const signature =
      '<div data-type="signature"><p><strong>Patrick Sluka</strong></p>' +
      '<p><img src="data:image/png;base64,iVBORw0KGgo=" width="146"></p></div>';
    const html = `<p>Guten Abend Herr Schallwig</p><p></p><p>Vielen Dank</p><p></p>${signature}`;

    const out = fillEmptyParagraphs(html);

    expect(out).toContain("data:image/png;base64,iVBORw0KGgo=");
    expect(out).toContain('<div data-type="signature">');
    expect(out).toContain("<strong>Patrick Sluka</strong>");
    expect(out).toBe(
      `<p>Guten Abend Herr Schallwig</p><p><br></p><p>Vielen Dank</p><p><br></p>${signature}`
    );
  });

  it("leaves everything else byte-identical", () => {
    // The outgoing body is never parsed back, so the transformation must not
    // normalise quoting, casing or self-closing tags the way a DOM round-trip would.
    const html = '<p>A</p><IMG SRC=\'x.png\'/><p>B</p>';
    expect(fillEmptyParagraphs(html)).toBe(html);
  });
});
