import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DESIGNED_SIGNATURE } from "./signatureFixture";
import { signatureRange, hasVisibleContent, fillEmptyParagraphs, inlineComposeStyles, addSignatureDivider, composeTypography, extractLocalImages, dropImagesByCid, decodeFileUrl, extractDataImages, isEmbeddableImageType, OUTGOING_FONT_STACK, COMPOSE_FONTS, DEFAULT_COMPOSE_FONT_SIZE } from "./outgoingHtml";

const DEFAULT_TYPO = composeTypography("prudii", DEFAULT_COMPOSE_FONT_SIZE);

describe("inlineComposeStyles", () => {
  it("stamps margin, font, size and line height onto bare paragraphs", () => {
    const out = inlineComposeStyles("<p>Hallo</p>", DEFAULT_TYPO);
    expect(out).toBe(`<p style="margin:0 0 0.5em 0;font-family:${OUTGOING_FONT_STACK};font-size:11pt;line-height:1.5">Hallo</p>`);
  });

  it("uses the chosen font and size", () => {
    const out = inlineComposeStyles("<p>Hallo</p>", composeTypography("georgia", 14));
    expect(out).toContain(`font-family:${COMPOSE_FONTS.georgia.stack}`);
    expect(out).toContain("font-size:14pt");
  });

  it("swaps the stack's quotes when the attribute is single-quoted", () => {
    const out = inlineComposeStyles("<p style='text-align:center'>M</p>", composeTypography("trebuchet", 11));
    expect(out).toContain(`font-family:"Trebuchet MS"`);
    expect(out).not.toContain("'Trebuchet MS'");
  });

  it("keeps existing declarations and only adds what is missing", () => {
    const out = inlineComposeStyles('<p style="text-align: center">M</p>', DEFAULT_TYPO);
    expect(out).toContain("text-align: center");
    expect(out).toContain("margin:0 0 0.5em 0");
    expect(out).toContain("font-family:");
    expect(out).toContain("font-size:11pt");
    const withMargin = inlineComposeStyles('<p style="margin:0">M</p>', DEFAULT_TYPO);
    expect(withMargin.match(/margin/g)).toHaveLength(1);
    expect(withMargin).toContain("font-family:");
    const withSize = inlineComposeStyles('<p style="font-size:9pt">M</p>', DEFAULT_TYPO);
    expect(withSize.match(/font-size/g)).toHaveLength(1);
    expect(withSize).toContain("font-size:9pt");
  });

  it("is idempotent", () => {
    const once = inlineComposeStyles("<p>A</p><p><br></p>", DEFAULT_TYPO);
    expect(inlineComposeStyles(once, DEFAULT_TYPO)).toBe(once);
  });

  it("leaves other tags and quoted markup untouched", () => {
    const html = '<div>X</div><blockquote cite="a">Y</blockquote><img src="data:image/png;base64,AAA">';
    expect(inlineComposeStyles(html, DEFAULT_TYPO)).toBe(html);
  });
});

describe("addSignatureDivider", () => {
  const SIGNED = `<p>Hallo</p><div data-type="signature"><p>Patrick</p></div>`;

  it("puts a short line in the accent colour above the signature", () => {
    const out = addSignatureDivider(SIGNED, "#10b981");
    const signature = out.slice(out.indexOf('<div data-type="signature">'));
    expect(signature.indexOf("data-prudii-divider")).toBeGreaterThan(0);
    expect(signature.indexOf("data-prudii-divider")).toBeLessThan(signature.indexOf("Patrick"));
    expect(out).toContain('width="48"');
    expect(out).toContain('bgcolor="#10b981"');
  });

  it("leaves mail without a signature alone", () => {
    expect(addSignatureDivider("<p>Hallo</p>", "#10b981")).toBe("<p>Hallo</p>");
  });

  it("adds nothing above an emptied signature", () => {
    const html = `<p>Hallo</p><div data-type="signature"><p><br></p></div>`;
    expect(addSignatureDivider(html, "#10b981")).toBe(html);
  });

  it("sets apart a signature that is only a logo", () => {
    expect(addSignatureDivider(`<div data-type="signature"><p><img src="cid:logo"></p></div>`, "#10b981")).toContain("data-prudii-divider");
  });

  it("is idempotent", () => {
    const once = addSignatureDivider(SIGNED, "#10b981");
    expect(addSignatureDivider(once, "#10b981")).toBe(once);
  });
});

describe("hasVisibleContent", () => {
  it("sees text and images", () => {
    expect(hasVisibleContent("<p>Anna</p>")).toBe(true);
    expect(hasVisibleContent('<p><img src="cid:logo"></p>')).toBe(true);
  });

  it("ignores empty markup, line breaks and blanks", () => {
    expect(hasVisibleContent("")).toBe(false);
    expect(hasVisibleContent("<div><br></div>")).toBe(false);
    expect(hasVisibleContent("<p>&nbsp; </p><p></p>")).toBe(false);
  });
});

describe("signature area", () => {
  const OPEN = '<div data-type="signature">';
  const doc = `<p>Hi</p>${OPEN}${DESIGNED_SIGNATURE}</div><p>danach</p>`;

  it("signatureRange spans exactly the nested content", () => {
    const r = signatureRange(doc)!;
    expect(doc.slice(r.contentStart, r.contentEnd)).toBe(DESIGNED_SIGNATURE);
    expect(doc.slice(r.start, r.contentStart)).toBe(OPEN);
    expect(doc.slice(r.contentEnd, r.end)).toBe("</div>");
    expect(signatureRange("<p>x</p>")).toBeNull();
  });

  it("keeps the signature markup byte-identical and styles the outer div", () => {
    const out = inlineComposeStyles(fillEmptyParagraphs(doc), DEFAULT_TYPO);
    const r = signatureRange(out)!;
    expect(out.slice(r.contentStart, r.contentEnd)).toBe(DESIGNED_SIGNATURE);
    expect(out.slice(r.start, r.contentStart)).toBe(`<div data-type="signature" style="font-family:${OUTGOING_FONT_STACK};font-size:11pt;line-height:1.5">`);
    expect(out).toContain("<p style=");
    expect(out.startsWith('<p style="')).toBe(true);
    expect(out).toContain(">Hi</p>");
    expect(out).toContain(">danach</p>");
    expect(out.slice(out.indexOf(">danach") - 120, out.indexOf(">danach"))).toContain("font-size:11pt");
    expect(inlineComposeStyles(out, DEFAULT_TYPO)).toBe(out);
  });

  it("adds one divider right after the opening tag and nothing else", () => {
    const out = addSignatureDivider(doc, "#10b981");
    expect(out.split("data-prudii-divider")).toHaveLength(2);
    const r = signatureRange(out)!;
    expect(out.slice(r.contentStart, r.contentEnd).endsWith(DESIGNED_SIGNATURE)).toBe(true);
    expect(out.slice(r.contentStart)).toContain("<table data-prudii-divider");
    expect(addSignatureDivider(out, "#10b981")).toBe(out);
  });

  it("finds the divider target after the outer div got a style", () => {
    const styled = inlineComposeStyles(doc, DEFAULT_TYPO);
    expect(addSignatureDivider(styled, "#10b981")).toContain("data-prudii-divider");
  });

  it("gives a plain signature the mail's font, size and line height", () => {
    const out = inlineComposeStyles(`<p>Hi</p>${OPEN}<div>Anna Weber</div></div>`, composeTypography("georgia", 14));
    expect(out).toContain(`${OPEN.slice(0, -1)} style="font-family:${COMPOSE_FONTS.georgia.stack};font-size:14pt;line-height:1.5"><div>Anna Weber</div>`);
  });

  it("gives no divider to a signature that is only a line break", () => {
    const html = `<p>Hi</p>${OPEN}<div><br></div></div>`;
    expect(addSignatureDivider(html, "#10b981")).toBe(html);
  });
});

describe("Prudii default font", () => {
  it("leads with Bahnschrift, which ships with Windows, so Outlook there renders it", () => {
    expect(OUTGOING_FONT_STACK.split(",")[0].trim()).toBe("Bahnschrift");
  });

  it("falls back to Avenir Next on Apple platforms, which have no Bahnschrift", () => {
    expect(OUTGOING_FONT_STACK.split(",")[1].trim()).toBe("'Avenir Next'");
  });

  it("gives subject and recipients the same font as the mail body", () => {
    const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");
    const block = css.match(/\.compose-writing \{([^}]*)\}/)![1];
    expect(block).toContain(`font-family: ${OUTGOING_FONT_STACK};`);
  });
});

describe("composeTypography", () => {
  it("resolves a known font and size", () => {
    expect(composeTypography("arial", 14)).toEqual({ fontStack: COMPOSE_FONTS.arial.stack, fontSizePt: 14 });
  });

  it("falls back to the defaults for unknown values", () => {
    // Settings written by a newer version may carry ids this build does not know.
    expect(composeTypography("comic-sans", 13)).toEqual({ fontStack: OUTGOING_FONT_STACK, fontSizePt: DEFAULT_COMPOSE_FONT_SIZE });
  });
});

describe("decodeFileUrl", () => {
  it("strips the prefix from raw Windows paths without adding a root slash", () => {
    expect(decodeFileUrl("file://C:\\Users\\x\\logo.png")).toBe("C:\\Users\\x\\logo.png");
  });

  it("drops the URL root slash in front of a drive letter", () => {
    expect(decodeFileUrl("file:///C:/Users/x/logo.png")).toBe("C:/Users/x/logo.png");
  });

  it("keeps the leading slash on POSIX paths", () => {
    expect(decodeFileUrl("file:///Users/x/logo.png")).toBe("/Users/x/logo.png");
  });

  it("collapses the fourth slash older bodies carry", () => {
    // The backend used to join "file:///" to a path that already began with a
    // slash; those bodies are still in the database.
    expect(decodeFileUrl("file:////Users/x/logo.png")).toBe("/Users/x/logo.png");
  });
});

describe("extractLocalImages", () => {
  it("rewrites file:// image sources to cid: and reports the local paths", () => {
    const html = '<p>Hi</p><blockquote><img src="file://C:\\Users\\x\\attachments\\m1\\logo.png" width="80"></blockquote>';
    const { html: out, images } = extractLocalImages(html);
    expect(images).toEqual([{ path: "C:\\Users\\x\\attachments\\m1\\logo.png", cid: "inline-1@prudii" }]);
    expect(out).toContain('src="cid:inline-1@prudii"');
    expect(out).not.toContain("file://");
    expect(out).toContain('width="80"');
  });

  it("reuses one cid when the same file appears twice", () => {
    const html = '<img src="file://C:\\a\\x.png"><img src="file://C:\\a\\x.png">';
    const { html: out, images } = extractLocalImages(html);
    expect(images).toHaveLength(1);
    expect(out.match(/cid:inline-1@prudii/g)).toHaveLength(2);
  });

  it("assigns distinct cids to distinct files", () => {
    const html = '<img src="file://C:\\a\\x.png"><img src="file://C:\\a\\y.png">';
    const { images } = extractLocalImages(html);
    expect(images.map((i) => i.cid)).toEqual(["inline-1@prudii", "inline-2@prudii"]);
  });

  it("tolerates file:/// with three slashes and percent-encoded paths", () => {
    const html = '<img src="file:///C:/Users/x/gr%C3%B6%C3%9Fe.png">';
    const { images } = extractLocalImages(html);
    expect(images[0].path).toBe("C:/Users/x/größe.png");
  });

  it("takes an apostrophe and an encoded ampersand as part of the path", () => {
    const html = `<img src="file:///C:/Users/O'Brien/logo.png"><img src='file:///C:/a&amp;b/logo.png'>`;
    const { html: out, images } = extractLocalImages(html);
    expect(images.map((i) => i.path)).toEqual(["C:/Users/O'Brien/logo.png", "C:/a&b/logo.png"]);
    expect(out).toBe(`<img src="cid:inline-1@prudii"><img src='cid:inline-2@prudii'>`);
  });

  it("leaves html without local images byte-identical", () => {
    const html = '<p>Text</p><img src="data:image/png;base64,AAA"><img src="https://x.de/a.png">';
    const { html: out, images } = extractLocalImages(html);
    expect(out).toBe(html);
    expect(images).toHaveLength(0);
  });
});

describe("extractDataImages", () => {
  it("turns data: images into one cid part per distinct image", () => {
    const logo = "data:image/png;base64,iVBORw0KGgo=";
    const shot = "data:image/jpeg;base64,/9j/4AAQ";
    const { html, images } = extractDataImages(`<p><img src="${logo}" width="150"><img src='${shot}'><img src="${logo}"></p>`);
    expect(html).toBe(`<p><img src="cid:embedded-1@prudii" width="150"><img src='cid:embedded-2@prudii'><img src="cid:embedded-1@prudii"></p>`);
    expect(images).toEqual([
      { cid: "embedded-1@prudii", type: "image/png", data: "iVBORw0KGgo=", name: "image-1.png" },
      { cid: "embedded-2@prudii", type: "image/jpeg", data: "/9j/4AAQ", name: "image-2.jpg" },
    ]);
  });
  it("leaves web, cid and file images alone", () => {
    const html = `<img src="https://x/y.png"><img src="cid:a@b"><img src="file:///C:/x.png">`;
    expect(extractDataImages(html)).toEqual({ html, images: [] });
  });
  it("unwraps a payload that quoted HTML broke across lines", () => {
    const { html, images } = extractDataImages(`<img src="data:image/png;base64,iVBO\r\n Rw0K\tGgo=">`);
    expect(html).toBe(`<img src="cid:embedded-1@prudii">`);
    expect(images).toEqual([{ cid: "embedded-1@prudii", type: "image/png", data: "iVBORw0KGgo=", name: "image-1.png" }]);
  });
  it("leaves a payload that is not valid base64 as data:", () => {
    const html = `<img src="data:image/png;base64,iVBO*w0KGgo="><img src="data:image/png;base64,iVBORw0KGgo"><img src="data:image/png;base64,QR==">`;
    expect(extractDataImages(html)).toEqual({ html, images: [] });
  });
});

describe("isEmbeddableImageType", () => {
  it("accepts the types extractDataImages embeds", () => {
    expect(isEmbeddableImageType("image/PNG")).toBe(true);
    expect(isEmbeddableImageType("image/jpeg")).toBe(true);
    expect(isEmbeddableImageType("image/svg+xml")).toBe(false);
    expect(isEmbeddableImageType("application/octet-stream")).toBe(false);
  });
});

describe("dropImagesByCid", () => {
  it("removes exactly the unresolvable images", () => {
    const html = '<img src="cid:inline-1@prudii"><p>A</p><img src="cid:inline-2@prudii">';
    const out = dropImagesByCid(html, ["inline-2@prudii"]);
    expect(out).toBe('<img src="cid:inline-1@prudii"><p>A</p>');
  });

  it("is a no-op for an empty cid list", () => {
    const html = '<img src="cid:inline-1@prudii">';
    expect(dropImagesByCid(html, [])).toBe(html);
  });
});

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
