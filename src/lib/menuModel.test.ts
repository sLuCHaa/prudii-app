import { describe, it, expect } from "vitest";
import { moveFocus, typeaheadIndex, clampToViewport, submenuPosition, type MenuEntry } from "./menuModel";

const item = (id: string, extra: Partial<Extract<MenuEntry, { kind: "item" }>> = {}): MenuEntry => ({ kind: "item", id, label: id, ...extra });
const entries: MenuEntry[] = [
  { kind: "header", label: "3 selected" },
  item("reply"),
  item("forward"),
  { kind: "separator" },
  item("archive", { disabled: true }),
  item("trash", { danger: true }),
];

describe("moveFocus", () => {
  it("skips headers, separators and disabled items and wraps", () => {
    expect(moveFocus(entries, -1, "ArrowDown")).toBe(1);
    expect(moveFocus(entries, 1, "ArrowDown")).toBe(2);
    expect(moveFocus(entries, 2, "ArrowDown")).toBe(5);
    expect(moveFocus(entries, 5, "ArrowDown")).toBe(1);
    expect(moveFocus(entries, 1, "ArrowUp")).toBe(5);
    expect(moveFocus(entries, -1, "ArrowUp")).toBe(5);
  });

  it("jumps with Home and End", () => {
    expect(moveFocus(entries, 5, "Home")).toBe(1);
    expect(moveFocus(entries, 1, "End")).toBe(5);
  });

  it("returns -1 when nothing is focusable", () => {
    expect(moveFocus([{ kind: "separator" }, item("x", { disabled: true })], -1, "ArrowDown")).toBe(-1);
  });
});

describe("typeaheadIndex", () => {
  const list: MenuEntry[] = [item("archive"), item("forward"), item("flag"), item("trash")];
  it("finds the next label starting with the query, after the current index, wrapping", () => {
    expect(typeaheadIndex(list, -1, "f")).toBe(1);
    expect(typeaheadIndex(list, 1, "f")).toBe(2);
    expect(typeaheadIndex(list, 2, "f")).toBe(1);
    expect(typeaheadIndex(list, 0, "fl")).toBe(2);
  });
  it("is case-insensitive and returns -1 without a match", () => {
    expect(typeaheadIndex(list, -1, "T")).toBe(3);
    expect(typeaheadIndex(list, -1, "z")).toBe(-1);
  });
});

describe("clampToViewport", () => {
  it("keeps the menu inside the viewport with a margin", () => {
    expect(clampToViewport(10, 10, 200, 100, 1000, 800)).toEqual({ left: 10, top: 10 });
    expect(clampToViewport(950, 780, 200, 100, 1000, 800)).toEqual({ left: 792, top: 692 });
    expect(clampToViewport(-5, -5, 200, 100, 1000, 800)).toEqual({ left: 8, top: 8 });
  });
});

describe("submenuPosition", () => {
  it("opens to the right of the anchor and flips left when there is no room", () => {
    expect(submenuPosition({ left: 100, top: 50, right: 300 }, 180, 120, 1000, 800)).toEqual({ left: 296, top: 46 });
    expect(submenuPosition({ left: 700, top: 50, right: 900 }, 180, 120, 1000, 800)).toEqual({ left: 524, top: 46 });
  });
  it("clamps vertically", () => {
    expect(submenuPosition({ left: 100, top: 760, right: 300 }, 180, 120, 1000, 800)).toEqual({ left: 296, top: 672 });
  });
});
