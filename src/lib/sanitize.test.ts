import { describe, it, expect } from "vitest";
import { escapeHtml, plainTextParagraph, restoreSanitizedHtml, sanitizeEmailHtml, sanitizeSignatureBlockHtml, sanitizeSignatureHtml, sanitizeSignatureHtmlReport, showLocalImages } from "./sanitize";
import { DESIGNED_SIGNATURE } from "./signatureFixture";

function parse(html: string): HTMLElement {
  return new DOMParser().parseFromString(`<!DOCTYPE html><body>${html}`, "text/html").body;
}

describe("escapeHtml", () => {
  it("escapes all HTML metacharacters", () => {
    expect(escapeHtml(`<img src="x" onerror='a&b'>`)).toBe(
      "&lt;img src=&quot;x&quot; onerror=&#39;a&amp;b&#39;&gt;"
    );
  });
});

describe("plainTextParagraph", () => {
  it("escapes markup and turns newlines into line breaks", () => {
    expect(plainTextParagraph(`<b>Hi</b>\nA & B`)).toBe("<p>&lt;b&gt;Hi&lt;/b&gt;<br>A &amp; B</p>");
  });
});

describe("sanitizeEmailHtml", () => {
  it("keeps cid: and blob: image sources so the inline resolver can map them", () => {
    const { html } = sanitizeEmailHtml('<img src="cid:logo@x"><img src="blob:null/1" alt="image001.png">');
    expect(html).toContain('src="cid:logo@x"');
    expect(html).toContain('src="blob:null/1"');
  });

  it("strips scripts and inline event handlers but keeps formatting", () => {
    const { html } = sanitizeEmailHtml(
      `<p onclick="alert(1)">Hi <b>there</b></p><script>alert(2)</script>`
    );
    expect(html).not.toContain("script");
    expect(html).not.toContain("onclick");
    expect(html).toContain("<b>there</b>");
  });

  it("neutralizes javascript: links", () => {
    const { html } = sanitizeEmailHtml(`<a href="javascript:alert(1)">x</a>`);
    expect(html).not.toContain("javascript:");
  });

  it("keeps https links and images", () => {
    const { html } = sanitizeEmailHtml(
      `<a href="https://example.com">link</a><img src="https://example.com/logo.png" width="100" height="50">`
    );
    expect(html).toContain(`https://example.com`);
    expect(html).toContain("<img");
  });

  it("strips external image sources when external images are blocked, keeps data URIs", () => {
    const { html } = sanitizeEmailHtml(
      `<img src="https://example.com/photo.png" width="100" height="100">` +
        `<img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20">`,
      false
    );
    expect(html).not.toContain("https://example.com/photo.png");
    expect(html).toContain("data:image/gif");
  });

  it("removes 1x1 tracking pixels and reports them", () => {
    const { html, trackers } = sanitizeEmailHtml(
      `<p>Text</p><img src="https://tracker.example.com/o.gif" width="1" height="1">`
    );
    expect(html).not.toContain("o.gif");
    expect(trackers.length).toBe(1);
    expect(trackers[0].type).toBe("pixel");
  });

  it("flags images from known tracking domains", () => {
    const { trackers } = sanitizeEmailHtml(
      `<img src="https://click.sendgrid.net/img.png" width="200" height="80">`
    );
    expect(trackers.some((t) => t.type === "tracking_domain")).toBe(true);
  });

  it("renders a mail's light variant whatever the system theme", () => {
    const { html } = sanitizeEmailHtml(
      "<style>@media (prefers-color-scheme: dark) { body { color: #fff !important } }" +
        "@media screen and (prefers-color-scheme:LIGHT) { .logo { display: block } }</style><p>Hallo</p>"
    );
    const css = parse(html).querySelector("style")!.textContent!;
    expect(css).not.toMatch(/prefers-color-scheme/i);
    expect(css).toContain("@media (max-width: -1px) { body { color: #fff !important } }");
    expect(css).toContain("@media screen and (min-width: 0px) { .logo { display: block } }");
  });
});

describe("reversible sanitize for editing a quote", () => {
  const LINK = '<p><a href="https://studio-halde.de/angebot" style="color: red">Angebot</a></p>';
  const BACKGROUND = `<table><tbody><tr><td style="background-image: url('https://studio-halde.de/bg.png'); color: #1f3d36">Stand</td></tr></tbody></table>`;
  const STYLE_BLOCK = "<style>.band { background: url(https://studio-halde.de/band.png) }</style><p class=\"band\">Studio Halde</p>";

  it("keeps links from opening while editing", () => {
    const { html } = sanitizeEmailHtml(LINK, true, true);
    expect(parse(html).querySelector("a")!.hasAttribute("href")).toBe(false);
  });

  it("gives links their real target back after editing", () => {
    const a = parse(restoreSanitizedHtml(sanitizeEmailHtml(LINK, true, true).html)).querySelector("a")!;
    expect(a.getAttribute("href")).toBe("https://studio-halde.de/angebot");
    expect(a.getAttribute("style")).toBe("color: red");
    expect(a.getAttributeNames().sort()).toEqual(["href", "style"]);
  });

  it("loads no CSS background images while editing", () => {
    const { html } = sanitizeEmailHtml(BACKGROUND + STYLE_BLOCK, true, true);
    const body = parse(html);
    expect(body.querySelector("td")!.getAttribute("style")).not.toMatch(/url\(/);
    expect(body.querySelector("style")!.textContent).not.toMatch(/url\(/);
  });

  it("sends CSS background images again after editing", () => {
    const body = parse(restoreSanitizedHtml(sanitizeEmailHtml(BACKGROUND + STYLE_BLOCK, true, true).html));
    const td = body.querySelector("td")!;
    expect(td.getAttribute("style")).toBe("background-image: url('https://studio-halde.de/bg.png'); color: #1f3d36");
    expect(td.getAttributeNames()).toEqual(["style"]);
    expect(body.querySelector("style")!.textContent).toBe(".band { background: url(https://studio-halde.de/band.png) }");
    expect(body.querySelector("style")!.getAttributeNames()).toEqual([]);
  });

  it("sends a mail's dark-mode styles again after editing", () => {
    const css = "@media (prefers-color-scheme: dark) { .band { color: #fff } }";
    const body = parse(restoreSanitizedHtml(sanitizeEmailHtml(`<style>${css}</style><p class="band">Studio Halde</p>`, true, true).html));
    expect(body.querySelector("style")!.textContent).toBe(css);
    expect(body.querySelector("style")!.getAttributeNames()).toEqual([]);
  });

  it("sends table background images again after editing", () => {
    const html = '<table background="https://studio-halde.de/bg.png"><tbody><tr><td>Stand</td></tr></tbody></table>';
    const { html: editing } = sanitizeEmailHtml(html, true, true);
    expect(parse(editing).querySelector("table")!.hasAttribute("background")).toBe(false);
    const table = parse(restoreSanitizedHtml(editing)).querySelector("table")!;
    expect(table.getAttribute("background")).toBe("https://studio-halde.de/bg.png");
    expect(table.getAttributeNames()).toEqual(["background"]);
  });

  it("ignores restore attributes a mail brings along itself", () => {
    const forged =
      '<a data-href="javascript:alert(1)">Angebot</a>' +
      '<img src="https://studio-halde.de/logo.png" data-prudii-src="https://tracker.example/p.gif" width="120" height="40">' +
      '<p data-prudii-style="background: url(https://tracker.example/p.gif)">Text</p>' +
      '<table data-prudii-background="https://tracker.example/p.gif"><tbody><tr><td>x</td></tr></tbody></table>';
    const body = parse(restoreSanitizedHtml(sanitizeEmailHtml(forged, true, true).html));
    expect(body.querySelector("a")!.hasAttribute("href")).toBe(false);
    expect(body.querySelector("img")!.getAttribute("src")).toBe("https://studio-halde.de/logo.png");
    expect(body.querySelector("p")!.hasAttribute("style")).toBe(false);
    expect(body.querySelector("table")!.hasAttribute("background")).toBe(false);
  });

  it("keeps a mail from making text clickable without a real link", () => {
    const { html } = sanitizeEmailHtml('<span data-href="https://evil.example">Hier klicken</span>');
    expect(parse(html).querySelector("[data-href]")).toBeNull();
  });

  it("shows stored inline images while editing and sends their file path again", () => {
    const shown = showLocalImages('<img src="file://C:\\Mail\\logo.png" alt="Logo">', () => "http://asset.localhost/logo.png", true);
    expect(parse(shown).querySelector("img")!.getAttribute("src")).toBe("http://asset.localhost/logo.png");
    const img = parse(restoreSanitizedHtml(shown)).querySelector("img")!;
    expect(img.getAttribute("src")).toBe("file://C:\\Mail\\logo.png");
    expect(img.getAttributeNames().sort()).toEqual(["alt", "src"]);
  });
});

describe("sanitizeSignatureHtmlReport", () => {
  it("counts what DOMPurify dropped and reports zero for clean input", () => {
    expect(sanitizeSignatureHtmlReport("<p><b>Alice</b></p>").removed).toBe(0);
    const dirty = sanitizeSignatureHtmlReport(`<p onclick="x()">Hi</p><script>x()</script>`);
    expect(dirty.removed).toBeGreaterThan(0);
    expect(dirty.html).not.toContain("onclick");
    expect(dirty.html).not.toContain("<script");
  });
});

describe("sanitizeSignatureHtml", () => {
  it("keeps formatting, drops scripts", () => {
    const out = sanitizeSignatureHtml(`<p><b>Alice</b></p><script>x()</script>`);
    expect(out).toContain("<b>Alice</b>");
    expect(out).not.toContain("script");
  });
});

describe("sanitizeSignatureBlockHtml", () => {
  const attr = (html: string, tag: string, name: string) => {
    const el = new DOMParser().parseFromString(sanitizeSignatureBlockHtml(html), "text/html").querySelector(tag);
    return el?.getAttribute(name) ?? null;
  };

  it("keeps a local file source on an image", () => {
    expect(attr('<img src="file:///C:/x/logo.png">', "img", "src")).toBe("file:///C:/x/logo.png");
  });

  it("drops a local file link", () => {
    expect(attr('<a href="file:///C:/x/doc.pdf">x</a>', "a", "href")).toBeNull();
  });

  it("drops a javascript link", () => {
    expect(attr('<a href="javascript:alert(1)">x</a>', "a", "href")).toBeNull();
  });

  it("keeps an inline data image", () => {
    expect(attr('<img src="data:image/png;base64,AAA=">', "img", "src")).toBe("data:image/png;base64,AAA=");
  });

  it("drops event handlers", () => {
    expect(attr('<p onclick="x()">Hi</p>', "p", "onclick")).toBeNull();
  });

  it("leaves the plain sanitizer unaffected afterwards", () => {
    sanitizeSignatureBlockHtml('<img src="file:///C:/x/logo.png">');
    expect(sanitizeSignatureHtml('<img src="file:///C:/x/logo.png">')).not.toContain("file:");
  });

  it("drops style sheets, forms, form controls and media", () => {
    const out = parse(sanitizeSignatureBlockHtml(
      `<p>a</p><style>p{color:red}</style><form action="https://evil.example/x"><input name="q"><textarea>t</textarea>` +
      `<select><option>o</option></select><button>Go</button></form><video autoplay src="https://evil.example/v.mp4"><source src="v.webm"><track src="t.vtt"></video>` +
      `<audio src="https://evil.example/a.mp3"></audio><dialog open>d</dialog><template><p>t</p></template><details open><summary>s</summary>x</details>`,
    ));
    expect(out.querySelector("style, form, input, textarea, select, option, button, video, source, track, audio, dialog, template, details, summary")).toBeNull();
    expect(out.querySelector("p")?.textContent).toBe("a");
    expect(out.textContent).not.toContain("color:red");
  });

  it("keeps a designed signature byte-identical", () => {
    expect(sanitizeSignatureBlockHtml(DESIGNED_SIGNATURE)).toBe(DESIGNED_SIGNATURE);
  });

  it("keeps the attributes classic signatures are laid out with", () => {
    const html =
      `<table width="400" bgcolor="#eeeeee" border="1" cellpadding="4" cellspacing="0" align="left"><tbody><tr>` +
      `<td valign="top" colspan="2" rowspan="1" class="c" dir="ltr" lang="de"><font face="Arial" color="#333333" size="2">Anna</font>` +
      `<a href="https://example.com" target="_blank" rel="noopener" title="t">x</a><img src="https://example.com/l.png" alt="l" width="80" height="20"></td></tr></tbody></table>`;
    expect(sanitizeSignatureBlockHtml(html)).toBe(html);
  });

  it("drops ids and data attributes", () => {
    const out = parse(sanitizeSignatureBlockHtml(`<div id="x" data-type="signature"><p>a</p></div>`));
    expect(out.querySelector("[id], [data-type]")).toBeNull();
    expect(out.textContent).toBe("a");
  });
});

describe("sanitizeSignatureBlockHtml layout attributes", () => {
  it("keeps the classic layout attributes signatures from Gmail and Outlook rely on", () => {
    const out = sanitizeSignatureBlockHtml(
      '<table><colgroup><col span="2"></colgroup><tbody><tr><td nowrap="">Anna</td></tr></tbody></table>' +
        '<br clear="all"><ol start="3" type="a"><li>x</li></ol><hr noshade="">'
    );
    expect(out).toContain('span="2"');
    expect(out).toContain("nowrap");
    expect(out).toContain('clear="all"');
    expect(out).toContain('start="3"');
    expect(out).toContain('type="a"');
    expect(out).toContain("noshade");
  });
});
