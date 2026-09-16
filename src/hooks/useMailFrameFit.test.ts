import { describe, it, expect } from "vitest";
import { fitScale } from "./useMailFrameFit";

describe("fitScale", () => {
  it("leaves mail that already fits alone", () => {
    expect(fitScale(760, 600)).toBe(1);
    expect(fitScale(760, 760)).toBe(1);
  });

  it("shrinks mail that is wider than the pane", () => {
    // A 13" MacBook with sidebar and list open leaves roughly this much.
    expect(fitScale(760, 800)).toBeCloseTo(0.95);
    expect(fitScale(600, 800)).toBeCloseTo(0.75);
  });

  it("stops at the floor rather than shrinking text out of readability", () => {
    // 1200px of content in a 400px pane would be 0.33 — the frame keeps its
    // sideways scroll below the floor instead.
    expect(fitScale(400, 1200)).toBe(0.55);
    expect(fitScale(100, 5000)).toBe(0.55);
  });

  it("honours a caller-supplied floor", () => {
    expect(fitScale(400, 1200, 0.25)).toBeCloseTo(1 / 3);
    expect(fitScale(400, 1200, 0.8)).toBe(0.8);
  });

  it("returns 1 for degenerate measurements", () => {
    // Both happen while the frame is still mounting.
    expect(fitScale(0, 800)).toBe(1);
    expect(fitScale(760, 0)).toBe(1);
    expect(fitScale(-5, 800)).toBe(1);
  });
});
