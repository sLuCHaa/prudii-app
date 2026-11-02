import { describe, it, expect } from "vitest";
import { rowShifts } from "./rowShift";

describe("rowShifts", () => {
  it("moves rows below a removed one back to where they stood", () => {
    const before = new Map([["a", 0], ["b", 72], ["c", 144], ["d", 216]]);
    const after = [{ key: "a", top: 0 }, { key: "c", top: 72 }, { key: "d", top: 144 }];
    expect(rowShifts(before, after)).toEqual([
      { key: "c", delta: 72 },
      { key: "d", delta: 72 },
    ]);
  });

  it("lets a row that just mounted travel with the row above it", () => {
    const before = new Map([["a", 0], ["b", 72], ["c", 144]]);
    const after = [{ key: "a", top: 0 }, { key: "c", top: 72 }, { key: "e", top: 144 }];
    expect(rowShifts(before, after)).toEqual([
      { key: "c", delta: 72 },
      { key: "e", delta: 72 },
    ]);
  });

  it("leaves rows above the gap alone", () => {
    const before = new Map([["a", 0], ["b", 72]]);
    const after = [{ key: "a", top: 0 }];
    expect(rowShifts(before, after)).toEqual([]);
  });

  it("orders by position, not by DOM order", () => {
    const before = new Map([["a", 0], ["b", 72], ["c", 144]]);
    const after = [{ key: "z", top: 72 }, { key: "a", top: 0 }, { key: "c", top: 40 }];
    expect(rowShifts(before, after)).toEqual([
      { key: "c", delta: 104 },
      { key: "z", delta: 104 },
    ]);
  });
});
