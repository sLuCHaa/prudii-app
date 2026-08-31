import { describe, it, expect } from "vitest";
import { fillEmptyParagraphs, inlineComposeStyles, extractLocalImages, dropImagesByCid, decodeFileUrl, OUTGOING_FONT_STACK } from "./outgoingHtml";

describe("inlineComposeStyles", () => {
  it("stamps margin and font onto bare paragraphs", () => {
    const out = inlineComposeStyles("<p>Hallo</p>");
    expect(out).toBe(`<p style="margin:0 0 0.5em 0;font-family:${OUTGOING_FONT_STACK}">Hallo</p>`);
  });

  it("keeps existing declarations and only adds what is missing", () => {
    const out = inlineComposeStyles('<p style="text-align: center">M</p>');
    expect(out).toContain("text-align: center");
    expect(out).toContain("margin:0 0 0.5em 0");
    expect(out).toContain("font-family:");
    const withMargin = inlineComposeStyles('<p style="margin:0">M</p>');
    expect(withMargin.match(/margin/g)).toHaveLength(1);
    expect(withMargin).toContain("font-family:");
  });

  it("is idempotent", () => {
    const once = inlineComposeStyles("<p>A</p><p><br></p>");
    expect(inlineComposeStyles(once)).toBe(once);
  });

  it("leaves other tags and quoted markup untouched", () => {
    const html = '<div>X</div><blockquote cite="a">Y</blockquote><img src="data:image/png;base64,AAA">';
    expect(inlineComposeStyles(html)).toBe(html);
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

  it("leaves html without local images byte-identical", () => {
    const html = '<p>Text</p><img src="data:image/png;base64,AAA"><img src="https://x.de/a.png">';
    const { html: out, images } = extractLocalImages(html);
    expect(out).toBe(html);
    expect(images).toHaveLength(0);
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
