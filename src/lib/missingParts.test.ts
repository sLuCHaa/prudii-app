import { describe, it, expect } from "vitest";
import { findMissingParts, stripMmlTags } from "./missingParts";

function att(over: Partial<{ filename: string; content_id: string | null }> = {}) {
  return { filename: "image001.png", content_id: null, ...over };
}

// A forward whose sender's Emacs never turned its MML placeholders into MIME
// parts: the tags arrive as body text, the files do not arrive at all.
const STRANDED_FORWARD = `-------- Forwarded Message --------
From: Volker Hübchen <v.huebchen@kalefeld.de>

Mit freundlichen Grüßen
Volker Hübchen
[cid:image002.png@01DD3937.AB133490]
Kleiner Hagen 4

Matthias Märsch

[cid:image001.png@01DD3936.B1DFBBF0]

Messtex
Wehrbach 22a

<#part type=image/png filename="/tmp/image001.png"><#/part>
<#part type=image/png filename="/tmp/image002.png"><#/part>
<#part type=application/vnd.openxmlformats-officedocument.spreadsheetml.sheet filename="/tmp/bereinigte WZ-Tauschliste 2026.xlsx"><#/part>
`;

describe("stripMmlTags", () => {
  it("removes the tag block a stranded forward ends with", () => {
    const out = stripMmlTags(STRANDED_FORWARD);
    expect(out).not.toMatch(/<#/);
    expect(out).toMatch(/Wehrbach 22a$/);
  });

  it("returns a body without MML unchanged", () => {
    const text = "Hallo,\n\nanbei die Liste.\n\nGruß\n";
    expect(stripMmlTags(text)).toBe(text);
  });

  it("removes multipart wrappers too", () => {
    const out = stripMmlTags("Text\n<#multipart type=mixed>\n<#part type=image/png filename=\"a.png\"><#/part>\n<#/multipart>\n");
    expect(out).toBe("Text");
  });

  it("keeps words that merely start like a tag", () => {
    const text = "Siehe <#partner> und <#parts>.";
    expect(stripMmlTags(text)).toBe(text);
  });

  it("collapses the blank run a removed tag leaves behind", () => {
    const out = stripMmlTags("Oben\n\n<#part type=image/png filename=\"a.png\"><#/part>\n\nUnten\n");
    expect(out).toBe("Oben\n\nUnten");
  });
});

describe("findMissingParts", () => {
  it("names every file the stranded forward announces but does not carry", () => {
    const { names, count } = findMissingParts({ body_text: STRANDED_FORWARD }, []);
    expect(names).toEqual(["image002.png", "image001.png", "bereinigte WZ-Tauschliste 2026.xlsx"]);
    expect(count).toBe(3);
  });

  it("counts a file announced as both a cid marker and an MML tag once", () => {
    const text = "[cid:image001.png@abc]\n<#part type=image/png filename=\"/tmp/image001.png\"><#/part>";
    expect(findMissingParts({ body_text: text }, [])).toEqual({ names: ["image001.png"], count: 1 });
  });

  it("reports nothing when the part is in the attachment list", () => {
    const text = "[cid:image001.png@01DD3936.B1DFBBF0]";
    expect(findMissingParts({ body_text: text }, [att({ content_id: "<image001.png@01DD3936.B1DFBBF0>" })])).toEqual({ names: [], count: 0 });
  });

  it("reports nothing for an attachment that is listed but not downloaded yet", () => {
    // Presence in the list is the test, not a local file: during the download
    // window the body still points at a cid nothing has resolved.
    const html = '<img src="cid:logo@x">';
    expect(findMissingParts({ body_html: html }, [att({ filename: "logo.png", content_id: "logo@x" })])).toEqual({ names: [], count: 0 });
  });

  it("matches an attachment by filename when its content id differs", () => {
    const text = "[cid:image001.png@abc]";
    expect(findMissingParts({ body_text: text }, [att({ content_id: "<something-else@y>" })])).toEqual({ names: [], count: 0 });
  });

  it("names an unresolved html image after its content id", () => {
    expect(findMissingParts({ body_html: '<img src="cid:image002.png@01DD3937.AB133490">' }, [])).toEqual({
      names: ["image002.png"],
      count: 1,
    });
  });

  it("counts an unresolved html image whose content id names no file", () => {
    expect(findMissingParts({ body_html: '<img src="cid:ii_m1abc@mail.gmail.com">' }, [])).toEqual({ names: [], count: 1 });
  });

  it("falls back to the alt text when the content id names no file", () => {
    expect(findMissingParts({ body_html: '<img src="cid:ii_m1abc@mail.gmail.com" alt="Logo.png">' }, [])).toEqual({
      names: ["Logo.png"],
      count: 1,
    });
  });

  it("sees through the GMX Attachment/<base64> wrapper", () => {
    const html = `<img src="Attachment/${btoa("cid:image001.png@01DD2F0E")}">`;
    expect(findMissingParts({ body_html: html }, [])).toEqual({ names: ["image001.png"], count: 1 });
  });

  it("ignores blob:, https: and data: images", () => {
    const html = '<img src="blob:null/1"><img src="https://x.test/a.png"><img src="data:image/png;base64,AAAA">';
    expect(findMissingParts({ body_html: html }, [])).toEqual({ names: [], count: 0 });
  });

  it("counts a part referenced by both bodies once", () => {
    const mail = { body_html: '<img src="cid:image001.png@abc">', body_text: "[cid:image001.png@abc]" };
    expect(findMissingParts(mail, [])).toEqual({ names: ["image001.png"], count: 1 });
  });

  it("reports nothing for an ordinary mail", () => {
    const mail = { body_html: "<p>Hallo</p>", body_text: "Hallo" };
    expect(findMissingParts(mail, [])).toEqual({ names: [], count: 0 });
  });

  it("ignores a cid marker that names no file and sits in plain text", () => {
    // Plain-text bodies carry no proof an unnamed marker ever was an image;
    // only html <img> tags say so.
    expect(findMissingParts({ body_text: "[cid:ii_m1abc@mail.gmail.com]" }, [])).toEqual({ names: [], count: 0 });
  });
});
