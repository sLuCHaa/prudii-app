import { describe, it, expect } from "vitest";
import { anchorAt } from "./scrollAnchor";

const rows = [
  { index: 0, start: 0, end: 32 },
  { index: 1, start: 32, end: 104 },
  { index: 2, start: 104, end: 176 },
];
const keys = ["sep-today", "mail-a", "mail-b"];
const keyOf = (i: number) => keys[i] ?? null;

describe("anchorAt", () => {
  it("has no anchor at the very top", () => {
    expect(anchorAt(rows, keyOf, 0)).toBeNull();
  });

  it("anchors on the row that crosses the top edge", () => {
    expect(anchorAt(rows, keyOf, 50)).toEqual({ key: "mail-a", offset: 18 });
  });

  it("skips a row that ends exactly at the top edge", () => {
    expect(anchorAt(rows, keyOf, 104)).toEqual({ key: "mail-b", offset: 0 });
  });

  it("gives up on rows without a key", () => {
    expect(anchorAt(rows, () => null, 50)).toBeNull();
  });
});
