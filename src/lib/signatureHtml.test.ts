import { describe, it, expect } from "vitest";
import {
  parseSignature,
  setSignatureText,
  derivePlainText,
  htmlToPlainLines,
  buildPreviewHtml,
  collapseDataUris,
  expandDataUris,
  hasBrokenDataUri,
  hasStructure,
} from "./signatureHtml";

const PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

const SIGNATURE = `<table cellpadding="0" style="font-size: 13px;"><tbody><tr><td>
  <div style="font-weight: bold;">Patrick Sluka</div>
  <div>Full Stack &amp; Mobile Developer</div>
</td></tr><tr><td><img src="${PIXEL}" width="146"></td></tr></table>`;

describe("parseSignature", () => {
  it("indexes text nodes in document order and skips whitespace", () => {
    const model = parseSignature(SIGNATURE);
    expect(model.texts).toEqual(["Patrick Sluka", "Full Stack & Mobile Developer"]);
  });

  it("returns no texts for an empty signature", () => {
    expect(parseSignature("").texts).toEqual([]);
  });
});

describe("setSignatureText", () => {
  it("changes the text without touching structure, styles or the image", () => {
    const model = parseSignature(SIGNATURE);
    const html = setSignatureText(model, 1, "Senior Full Stack Developer");

    expect(html).toContain("Senior Full Stack Developer");
    expect(html).not.toContain("Full Stack &amp; Mobile Developer");
    expect(html).toContain('cellpadding="0"');
    expect(html).toContain("font-weight: bold;");
    expect(html).toContain(PIXEL);
    expect(html).toContain("Patrick Sluka");
  });

  it("escapes markup typed into a text node", () => {
    const model = parseSignature(SIGNATURE);
    const html = setSignatureText(model, 0, "<script>alert(1)</script>");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("leaves attribute values alone when their text resembles the edit", () => {
    const model = parseSignature('<a href="Patrick">Patrick</a>');
    const html = setSignatureText(model, 0, "Anna");
    expect(html).toContain('href="Patrick"');
    expect(html).toContain(">Anna<");
  });
});

describe("buildPreviewHtml", () => {
  it("wraps each indexed text node in an editable span", () => {
    const preview = buildPreviewHtml(SIGNATURE);
    expect(preview).toContain('data-sig-text="0"');
    expect(preview).toContain('data-sig-text="1"');
    expect(preview).toContain('contenteditable="plaintext-only"');
    expect(preview).toContain(PIXEL);
  });

  it("keeps the span indexes aligned with the model", () => {
    const model = parseSignature(SIGNATURE);
    const preview = buildPreviewHtml(SIGNATURE);
    const doc = new DOMParser().parseFromString(preview, "text/html");
    model.texts.forEach((text, i) => {
      expect(doc.querySelector(`[data-sig-text="${i}"]`)?.textContent).toBe(text);
    });
  });
});

describe("data URI collapsing", () => {
  it("round-trips losslessly", () => {
    const { html, images } = collapseDataUris(SIGNATURE);
    expect(html).not.toContain(PIXEL);
    expect(html).toContain("‹1 · ");
    expect(images).toEqual([PIXEL]);
    expect(expandDataUris(html, images)).toContain(PIXEL);
  });

  it("drops the image when its placeholder was deleted", () => {
    const { images } = collapseDataUris(SIGNATURE);
    const withoutImg = '<table><tbody><tr><td>Patrick</td></tr></tbody></table>';
    expect(expandDataUris(withoutImg, images)).not.toContain(PIXEL);
  });

  it("gives two placeholders to two identical images", () => {
    const { html, images } = collapseDataUris(
      `<img src="${PIXEL}"><img src="${PIXEL}">`
    );
    expect(images).toHaveLength(2);
    expect(html).toContain("‹1 · ");
    expect(html).toContain("‹2 · ");
    expect(expandDataUris(html, images)).toBe(`<img src="${PIXEL}"><img src="${PIXEL}">`);
  });

  // The readable half is translated, so matching must never depend on its wording.
  it("round-trips whatever language the label is in", () => {
    const { html, images } = collapseDataUris(SIGNATURE, (kb) => `图片 · ${kb} KB`);
    expect(html).toContain("图片");
    expect(expandDataUris(html, images)).toContain(PIXEL);
  });

  it("keeps the index outside the translated label", () => {
    const { html } = collapseDataUris(`<img src="${PIXEL}">`, () => "изображение");
    expect(html).toContain("‹1 · изображение›");
  });
});

describe("hasBrokenDataUri", () => {
  const { html: collapsed, images } = collapseDataUris(SIGNATURE);

  it("passes a signature whose placeholders all resolved", () => {
    expect(hasBrokenDataUri(expandDataUris(collapsed, images))).toBe(false);
  });

  it("passes a signature with no images at all", () => {
    expect(hasBrokenDataUri("<div>Patrick</div>")).toBe(false);
  });

  it("catches a placeholder whose closing guillemet was deleted", () => {
    const mangled = collapsed.replace("›", "");
    expect(hasBrokenDataUri(expandDataUris(mangled, images))).toBe(true);
  });

  it("catches a placeholder whose index no longer has an image", () => {
    const renumbered = collapsed.replace("‹1 · ", "‹5 · ");
    expect(hasBrokenDataUri(expandDataUris(renumbered, images))).toBe(true);
  });

  it("catches a placeholder the user typed over instead of deleting", () => {
    const typedOver = `<img src="data:image/png;base64,Bild 1 - 11 KB">`;
    expect(hasBrokenDataUri(expandDataUris(typedOver, images))).toBe(true);
  });

  it("catches an emptied payload rather than storing a blank image", () => {
    expect(hasBrokenDataUri(`<img src="data:image/png;base64,">`)).toBe(true);
  });

  // Deleting the whole <img> is a legitimate edit and must stay allowed.
  it("passes when the image element was removed outright", () => {
    expect(hasBrokenDataUri("<table><tbody><tr><td>Patrick</td></tr></tbody></table>")).toBe(false);
  });

  // The closing paren must not be read as payload, or every CSS background image
  // would be reported as damaged and the commit refused forever.
  it("passes an intact image inside a css url()", () => {
    expect(hasBrokenDataUri(`<div style="background:url(${PIXEL})">x</div>`)).toBe(false);
  });

  it("still catches a mangled placeholder inside a css url()", () => {
    const { html, images } = collapseDataUris(`<div style="background:url(${PIXEL})">x</div>`);
    const mangled = html.replace("‹", "");
    expect(hasBrokenDataUri(expandDataUris(mangled, images))).toBe(true);
  });
});

describe("derivePlainText", () => {
  it("keeps the visible text and ignores style and script", () => {
    const text = derivePlainText(
      "<style>.a{color:red}</style><div>Patrick</div><div>Developer</div>"
    );
    expect(text).toContain("Patrick");
    expect(text).toContain("Developer");
    expect(text).not.toContain("color:red");
  });
});

describe("htmlToPlainLines", () => {
  it("returns a single line for a single div", () => {
    expect(htmlToPlainLines("<div>A</div>")).toBe("A");
  });

  it("round-trips two div lines to two text lines", () => {
    expect(htmlToPlainLines("<div>A</div><div>B</div>")).toBe("A\nB");
  });

  it("keeps a blank line in the middle", () => {
    expect(htmlToPlainLines("<div>A</div><div><br></div><div>B</div>")).toBe("A\n\nB");
  });

  it("keeps a trailing empty line instead of eating it", () => {
    expect(htmlToPlainLines("<div>A</div><div><br></div>")).toBe("A\n");
  });

  it("keeps a leading empty line instead of eating it", () => {
    expect(htmlToPlainLines("<div><br></div><div>Hello</div>")).toBe("\nHello");
  });

  it("keeps a leading empty line when it's the only content", () => {
    expect(htmlToPlainLines("<div><br></div><div><br></div>")).toBe("\n");
  });

  it("treats a lone <br> placeholder div as a single empty line", () => {
    expect(htmlToPlainLines("<div><br></div>")).toBe("");
  });

  it("decodes entities back to literal characters", () => {
    expect(htmlToPlainLines("<div>&lt;</div>")).toBe("<");
  });

  it("splits on a bare top-level <br> with no wrapping div", () => {
    expect(htmlToPlainLines("Hello<br>World")).toBe("Hello\nWorld");
  });

  it("keeps loose top-level text between block siblings instead of dropping it", () => {
    expect(htmlToPlainLines("<div>A</div>loose text<div>B</div>")).toBe("A\nloose text\nB");
  });

  it("returns an empty string for an empty signature", () => {
    expect(htmlToPlainLines("")).toBe("");
  });
});

describe("hasStructure", () => {
  it("treats empty and plain divs as structureless", () => {
    expect(hasStructure("")).toBe(false);
    expect(hasStructure("<div>Hi</div><div><br></div>")).toBe(false);
  });

  it("treats tables, inline styles, images and links as structured", () => {
    expect(hasStructure("<table><tbody><tr><td>x</td></tr></tbody></table>")).toBe(true);
    expect(hasStructure('<div style="color:red">x</div>')).toBe(true);
    expect(hasStructure(`<img src="${PIXEL}">`)).toBe(true);
    expect(hasStructure('<a href="https://x.de">x</a>')).toBe(true);
  });
});
