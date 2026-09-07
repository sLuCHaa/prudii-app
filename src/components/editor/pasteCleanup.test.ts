import { describe, it, expect } from "vitest";
import { cleanPastedHtml } from "./pasteCleanup";

describe("cleanPastedHtml", () => {
  it("strips style and class attributes from every element", () => {
    const html = '<p style="color:red" class="foo">Hi <b style="font-weight:900" class="bar">there</b></p>';
    const out = cleanPastedHtml(html);
    expect(out).not.toContain("style=");
    expect(out).not.toContain("class=");
    expect(out).toContain("Hi");
    expect(out).toContain("<b>there</b>");
  });

  it("removes style, script, link, meta and title elements entirely", () => {
    const html =
      "<title>Doc</title>" +
      "<style>p{color:red}</style>" +
      "<link rel=\"stylesheet\" href=\"x.css\">" +
      "<meta charset=\"utf-8\">" +
      "<script>alert(1)</script>" +
      "<p>Kept</p>";
    const out = cleanPastedHtml(html);
    expect(out).not.toContain("Doc");
    expect(out).not.toContain("color:red");
    expect(out).not.toContain("<link");
    expect(out).not.toContain("<meta");
    expect(out).not.toContain("<script");
    expect(out).not.toContain("alert(1)");
    expect(out).toBe("<p>Kept</p>");
  });

  it("stays under the 400,000 char threshold and keeps structural tags untouched otherwise", () => {
    const html = `<p>${"a".repeat(399_999)}</p>`;
    const out = cleanPastedHtml(html);
    expect(out).toBe(html);
  });

  it("falls back to escaped plain text with <br> line breaks above 400,000 chars", () => {
    const filler = "a".repeat(400_001);
    const html = `${filler}\nsecond line`;
    const out = cleanPastedHtml(html);
    expect(out).toBe(`<p>${filler}<br>second line</p>`);
  });

  it("escapes leftover markup and entities when falling back to plain text", () => {
    const filler = "x".repeat(400_000);
    const html = `${filler}<b>bold</b> &amp; more`;
    const out = cleanPastedHtml(html);
    expect(out).not.toContain("<b>");
    expect(out).toContain("bold &amp; more");
  });
});
