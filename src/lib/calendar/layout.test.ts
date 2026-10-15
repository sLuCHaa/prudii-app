import { describe, it, expect } from "vitest";
import { layoutDay, layoutSpans } from "./layout";

describe("layoutDay", () => {
  it("gives non-overlapping items the full width", () => {
    const placed = layoutDay([{ id: "a", startMin: 540, endMin: 600 }, { id: "b", startMin: 600, endMin: 660 }]);
    expect(placed.get("a")).toEqual({ col: 0, cols: 1 });
    expect(placed.get("b")).toEqual({ col: 0, cols: 1 });
  });

  it("splits overlapping items into columns and reuses freed ones", () => {
    const placed = layoutDay([
      { id: "a", startMin: 540, endMin: 600 },
      { id: "b", startMin: 570, endMin: 660 },
      { id: "c", startMin: 610, endMin: 700 },
    ]);
    expect(placed.get("a")).toEqual({ col: 0, cols: 2 });
    expect(placed.get("b")).toEqual({ col: 1, cols: 2 });
    expect(placed.get("c")).toEqual({ col: 0, cols: 2 });
  });

  it("treats very short items as at least the minimum height", () => {
    const placed = layoutDay([{ id: "a", startMin: 540, endMin: 545 }, { id: "b", startMin: 550, endMin: 600 }]);
    expect(placed.get("b")?.cols).toBe(2);
  });
});

describe("layoutSpans", () => {
  it("stacks overlapping spans and lets later spans reuse free lanes", () => {
    const lanes = layoutSpans([
      { id: "long", startIdx: 0, endIdx: 4 },
      { id: "short", startIdx: 1, endIdx: 1 },
      { id: "late", startIdx: 5, endIdx: 6 },
      { id: "mid", startIdx: 2, endIdx: 3 },
    ]);
    expect(lanes.get("long")).toBe(0);
    expect(lanes.get("short")).toBe(1);
    expect(lanes.get("mid")).toBe(1);
    expect(lanes.get("late")).toBe(0);
  });
});
