import { describe, it, expect } from "vitest";
import { resolveInlineImages, removeUnresolvableImages, resolveInlineImagesInHtml, listedAttachments } from "./inlineImages";

function render(html: string): HTMLDivElement {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div;
}

function att(over: Partial<{ filename: string; content_id: string | null; local_path: string | null; mime_type: string | null }>) {
  return { filename: "image001.jpg", content_id: null, local_path: "C:\\data\\att\\image001.jpg", mime_type: "image/jpeg", ...over };
}

const GMX_TOKEN = "Y2lkOmltYWdlMDAxLmpwZ0AwMUREMkYwRS5FQTU2ODgxMA"; // base64("cid:image001.jpg@01DD2F0E.EA568810")

describe("resolveInlineImages", () => {
  it("rewrites a cid: reference to the attachment's file URL", () => {
    const div = render('<img src="cid:image001.jpg@01DD2F0E.EA568810">');
    resolveInlineImages(div, [att({ content_id: "<image001.jpg@01DD2F0E.EA568810>" })]);
    expect(div.querySelector("img")!.getAttribute("src")).toBe("file:///C:/data/att/image001.jpg");
  });

  it("matches content ids regardless of case", () => {
    const div = render('<img src="cid:ABC@symfony">');
    resolveInlineImages(div, [att({ content_id: "abc@symfony" })]);
    expect(div.querySelector("img")!.getAttribute("src")).toBe("file:///C:/data/att/image001.jpg");
  });

  it("decodes the GMX Attachment/<base64> wrapper around a cid reference", () => {
    const div = render(`<img src="Attachment/${GMX_TOKEN}">`);
    resolveInlineImages(div, [att({ content_id: "<image001.jpg@01DD2F0E.EA568810>" })]);
    expect(div.querySelector("img")!.getAttribute("src")).toBe("file:///C:/data/att/image001.jpg");
  });

  it("maps a blob: image to the image attachment named in its alt text", () => {
    const div = render('<img src="blob:null/4e83da26-a351-4224-bd0d-7903fed699bc" alt="image001.png">');
    resolveInlineImages(div, [att({ filename: "image001.png", local_path: "C:\\data\\att\\image001.png", mime_type: "image/png" })]);
    expect(div.querySelector("img")!.getAttribute("src")).toBe("file:///C:/data/att/image001.png");
  });

  it("does not map a blob: image to a non-image attachment with the same name", () => {
    const div = render('<img src="blob:null/1" alt="antrag.pdf">');
    resolveInlineImages(div, [att({ filename: "antrag.pdf", local_path: "C:\\data\\att\\antrag.pdf", mime_type: "application/pdf" })]);
    expect(div.querySelector("img")!.getAttribute("src")).toBe("blob:null/1");
  });

  it("treats an octet-stream attachment with an image filename as an image", () => {
    const div = render('<img src="cid:x@symfony">');
    resolveInlineImages(div, [att({ filename: "6a199eaa3a4dc.jpeg", content_id: "x@symfony", local_path: "C:\\data\\att\\6a199eaa3a4dc.jpeg", mime_type: "application/octet-stream" })]);
    expect(div.querySelector("img")!.getAttribute("src")).toBe("file:///C:/data/att/6a199eaa3a4dc.jpeg");
  });

  it("ignores attachments without a local file", () => {
    const div = render('<img src="cid:x@y">');
    resolveInlineImages(div, [att({ content_id: "x@y", local_path: null })]);
    expect(div.querySelector("img")!.getAttribute("src")).toBe("cid:x@y");
  });

  it("leaves data:, https: and file: sources alone", () => {
    const html = '<img src="data:image/png;base64,AAAA"><img src="https://example.com/a.png"><img src="file:///C:/x.png">';
    const div = render(html);
    resolveInlineImages(div, [att({ content_id: "x@y" })]);
    expect(div.innerHTML).toBe(html);
  });
});

describe("removeUnresolvableImages", () => {
  it("removes images still pointing at cid:, blob: or Attachment/ sources and reports the count", () => {
    const div = render(`<p>a</p><img src="cid:x@y"><img src="blob:null/1" alt="image001.png"><img src="Attachment/${GMX_TOKEN}">`);
    expect(removeUnresolvableImages(div)).toBe(3);
    expect(div.querySelectorAll("img")).toHaveLength(0);
    expect(div.querySelector("p")!.textContent).toBe("a");
  });

  it("keeps resolved, remote and data: images", () => {
    const html = '<img src="file:///C:/x.png"><img src="https://example.com/a.png"><img src="data:image/png;base64,AAAA">';
    const div = render(html);
    expect(removeUnresolvableImages(div)).toBe(0);
    expect(div.innerHTML).toBe(html);
  });
});

describe("resolveInlineImagesInHtml", () => {
  it("resolves what it can and drops the rest, as a string", () => {
    const html = `<p>x</p><img src="Attachment/${GMX_TOKEN}"><img src="blob:null/1" alt="missing.png">`;
    const out = resolveInlineImagesInHtml(html, [att({ content_id: "<image001.jpg@01DD2F0E.EA568810>" })]);
    expect(out).toBe('<p>x</p><img src="file:///C:/data/att/image001.jpg">');
  });

  it("returns the input untouched when no image needs resolving", () => {
    const html = '<p>x</p><img src="https://example.com/a.png">';
    expect(resolveInlineImagesInHtml(html, [att({ content_id: "x@y" })])).toBe(html);
  });
});

describe("listedAttachments", () => {
  const base = { id: "a1", mail_id: "m1", size_bytes: 10 };
  const logo = { ...base, filename: "logo.png", mime_type: "image/png", content_id: "<logo@x>", is_inline: true, local_path: "C:\\att\\logo.png" };
  const pdf = { ...base, id: "a2", filename: "offer.pdf", mime_type: "application/pdf", content_id: null, is_inline: false, local_path: "C:\\att\\offer.pdf" };
  const sig = { ...base, id: "a3", filename: "smime.p7s", mime_type: "application/pkcs7-signature", content_id: null, is_inline: true, local_path: "C:\\att\\smime.p7s" };

  it("keeps regular attachments and hides signature parts", () => {
    expect(listedAttachments("<p>x</p>", [pdf, sig]).map((a) => a.id)).toEqual(["a2"]);
  });

  it("hides an inline image the body shows through its stored file", () => {
    const html = '<img src="file:///C:/att/logo.png">';
    expect(listedAttachments(html, [logo, pdf]).map((a) => a.id)).toEqual(["a2"]);
  });

  it("hides an inline image the body references by cid or GMX wrapper", () => {
    expect(listedAttachments('<img src="cid:logo@x">', [logo]).map((a) => a.id)).toEqual([]);
    expect(listedAttachments(`<img src="Attachment/${btoa("cid:logo@x").replace(/=+$/, "")}">`, [logo]).map((a) => a.id)).toEqual([]);
  });

  it("lists an inline image the body never shows", () => {
    // Inline-ness we inferred, so the body has to back it up. This is what keeps
    // a real photo visible when the sender attached one with a Content-ID.
    expect(listedAttachments("<p>no images</p>", [logo, pdf]).map((a) => a.id)).toEqual(["a1", "a2"]);
  });

  it("hides an image the sender declared inline even when the body cannot show it", () => {
    // Apple Mail's signature image: declared inline, referenced by a blob: URL of
    // the sender's own session under a name that does not match the stored file.
    const appleSig = {
      ...base,
      id: "a4",
      filename: "Outlook-lurd1yg3.jpg",
      mime_type: "image/jpeg",
      content_id: null,
      is_inline: true,
      declared_inline: true,
      local_path: "C:\att\Outlook-lurd1yg3.jpg",
    };
    const body = '<img src="blob:null/4e83da26" alt="image001.png">';
    expect(listedAttachments(body, [appleSig, pdf]).map((a) => a.id)).toEqual(["a2"]);
  });

  it("hides an inline image the body shows through the backend's own file URL", () => {
    // booking.com's inline images declare no disposition at all, so the body
    // check is all there is — and the backend used to write a fourth slash.
    const embedded = {
      ...base,
      id: "a5",
      filename: "attachment",
      mime_type: "image/png",
      content_id: "c0b2d6a9@MIME-Lite-HTML-1.25",
      is_inline: true,
      local_path: "/Users/p/att/attachment",
    };
    const body = '<img src="file:////Users/p/att/attachment">';
    expect(listedAttachments(body, [embedded]).map((a) => a.id)).toEqual([]);
  });

  it("still demands proof from rows stored before the declaration was known", () => {
    // declared_inline is absent, so the body check applies exactly as it used to.
    expect(listedAttachments("<p>no images</p>", [logo]).map((a) => a.id)).toEqual(["a1"]);
  });
});
