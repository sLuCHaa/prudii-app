import { describe, expect, it } from "vitest";
import { displayWidth, shouldTakeOverPaste, sortPastedFiles } from "./pasteFiles";

const file = (name: string, type: string) => new File([], name, { type });

describe("sortPastedFiles", () => {
  it("puts generic clipboard bitmaps inline", () => {
    const f = file("image.png", "image/png");
    expect(sortPastedFiles([f])).toEqual({ inline: [f], attachments: [] });
  });

  it("makes named photos attachments", () => {
    const f = file("IMG_1234.jpg", "image/jpeg");
    expect(sortPastedFiles([f])).toEqual({ inline: [], attachments: [f] });
  });

  it("makes documents attachments", () => {
    const f = file("bericht.pdf", "application/pdf");
    expect(sortPastedFiles([f])).toEqual({ inline: [], attachments: [f] });
  });

  it("splits mixed input", () => {
    const a = file("image.png", "image/png");
    const b = file("bericht.pdf", "application/pdf");
    expect(sortPastedFiles([a, b])).toEqual({ inline: [a], attachments: [b] });
  });
});

describe("displayWidth", () => {
  it("caps at 640", () => {
    expect(displayWidth(2880, 1.5)).toBe(640);
  });

  it("scales by the pixel ratio", () => {
    expect(displayWidth(900, 1.5)).toBe(600);
    expect(displayWidth(300, 1)).toBe(300);
  });
});

describe("shouldTakeOverPaste", () => {
  const img = file("image.png", "image/png");
  const real = file("bericht.pdf", "application/pdf");

  it("leaves generic image plus text to the text paste", () => {
    expect(shouldTakeOverPaste({ inline: [img], attachments: [] }, true)).toBe(false);
  });

  it("takes over a generic image alone", () => {
    expect(shouldTakeOverPaste({ inline: [img], attachments: [] }, false)).toBe(true);
  });

  it("takes over real files even with text", () => {
    expect(shouldTakeOverPaste({ inline: [], attachments: [real] }, true)).toBe(true);
  });

  it("ignores an empty clipboard", () => {
    expect(shouldTakeOverPaste({ inline: [], attachments: [] }, false)).toBe(false);
  });
});
