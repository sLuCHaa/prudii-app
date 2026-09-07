import { describe, it, expect } from "vitest";
import { isListNavKey, nextCursor, pageSize, spanIds } from "./listKeys";

describe("nextCursor", () => {
  it("moves one step and clamps at both ends", () => {
    expect(nextCursor(0, 5, "ArrowDown", 3)).toBe(1);
    expect(nextCursor(4, 5, "ArrowDown", 3)).toBe(4);
    expect(nextCursor(4, 5, "ArrowUp", 3)).toBe(3);
    expect(nextCursor(0, 5, "ArrowUp", 3)).toBe(0);
  });

  it("starts at the first row when nothing is selected", () => {
    expect(nextCursor(-1, 5, "ArrowDown", 3)).toBe(0);
    expect(nextCursor(-1, 5, "ArrowUp", 3)).toBe(0);
    expect(nextCursor(-1, 5, "End", 3)).toBe(4);
  });

  it("jumps with Home/End and pages with PageUp/PageDown", () => {
    expect(nextCursor(2, 10, "Home", 3)).toBe(0);
    expect(nextCursor(2, 10, "End", 3)).toBe(9);
    expect(nextCursor(2, 10, "PageDown", 3)).toBe(5);
    expect(nextCursor(8, 10, "PageDown", 3)).toBe(9);
    expect(nextCursor(2, 10, "PageUp", 3)).toBe(0);
    expect(nextCursor(7, 10, "PageUp", 3)).toBe(4);
  });

  it("returns -1 for an empty list", () => {
    expect(nextCursor(-1, 0, "ArrowDown", 3)).toBe(-1);
    expect(nextCursor(0, 0, "End", 3)).toBe(-1);
  });
});

describe("pageSize", () => {
  it("counts whole rows and never drops below one", () => {
    expect(pageSize(680, 68)).toBe(10);
    expect(pageSize(700, 68)).toBe(10);
    expect(pageSize(30, 68)).toBe(1);
    expect(pageSize(0, 68)).toBe(1);
  });
});

describe("spanIds", () => {
  const items = ["a", "b", "c", "d"].map((id) => ({ id }));
  it("returns the inclusive span in either direction", () => {
    expect(spanIds(items, 1, 3)).toEqual(["b", "c", "d"]);
    expect(spanIds(items, 3, 1)).toEqual(["b", "c", "d"]);
    expect(spanIds(items, 2, 2)).toEqual(["c"]);
  });
  it("clamps out-of-range indexes", () => {
    expect(spanIds(items, -1, 1)).toEqual(["a", "b"]);
    expect(spanIds(items, 2, 99)).toEqual(["c", "d"]);
    expect(spanIds([], 0, 0)).toEqual([]);
  });
});

describe("isListNavKey", () => {
  it("recognises exactly the six navigation keys", () => {
    for (const k of ["ArrowDown", "ArrowUp", "Home", "End", "PageUp", "PageDown"]) expect(isListNavKey(k)).toBe(true);
    for (const k of ["j", "Enter", " ", "ArrowLeft"]) expect(isListNavKey(k)).toBe(false);
  });
});
