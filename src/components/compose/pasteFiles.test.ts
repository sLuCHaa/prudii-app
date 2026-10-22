import { describe, expect, it } from "vitest";
import { clipboardHasText, displayWidth, insertInOrder, shouldTakeOverPaste, sortPastedFiles } from "./pasteFiles";

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

describe("clipboardHasText", () => {
  it("counts Office HTML with text", () => {
    const office = `<html><head><style>p{margin:0}</style></head><body><!--StartFragment--><p class=MsoNormal>Umsatz Q3</p><!--EndFragment--></body></html>`;
    expect(clipboardHasText(office, "")).toBe(true);
  });

  it("does not count HTML that only wraps the copied image", () => {
    expect(clipboardHasText(`<meta charset="utf-8"><img src="https://x/y.png" alt="">`, "")).toBe(false);
    expect(clipboardHasText(`<html><body><!--StartFragment--><img src="https://x/y.png">&nbsp;<!--EndFragment--></body></html>`, "")).toBe(false);
  });

  it("counts plain text and nothing else", () => {
    expect(clipboardHasText("", "Hallo")).toBe(true);
    expect(clipboardHasText("", "  \n")).toBe(false);
  });
});

describe("insertInOrder", () => {
  it("places items in their original order even when a later one is ready first", async () => {
    let releaseFirst!: (v: string) => void;
    const first = new Promise<string>((r) => (releaseFirst = r));
    const placed: string[] = [];
    const done = insertInOrder(["a", "b"], (item) => (item === "a" ? first : Promise.resolve("B")), (_item, p) => { placed.push(p); return true; }, () => placed.push("fallback"));
    await Promise.resolve();
    releaseFirst("A");
    await done;
    expect(placed).toEqual(["A", "B"]);
  });

  it("falls back for an item that cannot be placed and still places the rest", async () => {
    const placed: string[] = [];
    const fallen: string[] = [];
    await insertInOrder(
      ["a", "b", "c"],
      (item) => (item === "b" ? Promise.reject(new Error("decode")) : Promise.resolve(item.toUpperCase())),
      (item, p) => {
        if (item === "c") throw new Error("editor gone");
        placed.push(p);
        return true;
      },
      (item) => fallen.push(item),
    );
    expect(placed).toEqual(["A"]);
    expect(fallen).toEqual(["b", "c"]);
  });

  it("falls back when placing declines the prepared item", async () => {
    const fallen: string[] = [];
    await insertInOrder(["a"], () => Promise.resolve("A"), () => false, (item) => fallen.push(item));
    expect(fallen).toEqual(["a"]);
  });
});
