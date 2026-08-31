import { describe, it, expect } from "vitest";
import { escapeHtml, sanitizeEmailHtml, sanitizeSignatureHtml } from "./sanitize";

describe("escapeHtml", () => {
  it("escapes all HTML metacharacters", () => {
    expect(escapeHtml(`<img src="x" onerror='a&b'>`)).toBe(
      "&lt;img src=&quot;x&quot; onerror=&#39;a&amp;b&#39;&gt;"
    );
  });
});

describe("sanitizeEmailHtml", () => {
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
});

describe("sanitizeSignatureHtml", () => {
  it("keeps formatting, drops scripts", () => {
    const out = sanitizeSignatureHtml(`<p><b>Alice</b></p><script>x()</script>`);
    expect(out).toContain("<b>Alice</b>");
    expect(out).not.toContain("script");
  });
});
