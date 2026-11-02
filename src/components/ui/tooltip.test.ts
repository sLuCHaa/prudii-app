import { describe, it, expect } from "vitest";
import { clampCenter, tooltipDelay } from "./Tooltip";

describe("tooltipDelay", () => {
  it("waits the full delay when no tooltip was open just now", () => {
    expect(tooltipDelay(1000, 0, 450)).toBe(450);
    expect(tooltipDelay(1000, 1000, 450)).toBe(450);
  });

  it("opens at once right after a neighbour closed", () => {
    expect(tooltipDelay(1000, 1300, 450)).toBe(0);
  });
});

describe("clampCenter", () => {
  it("keeps a centered bubble where it is when it fits", () => {
    expect(clampCenter(500, 100, 1200)).toBe(500);
  });

  it("pushes a bubble off the left edge back in", () => {
    expect(clampCenter(26, 120, 1200)).toBe(68);
  });

  it("pushes a bubble off the right edge back in", () => {
    expect(clampCenter(1190, 120, 1200)).toBe(1132);
  });

  it("centers a bubble wider than the window", () => {
    expect(clampCenter(30, 900, 800)).toBe(400);
  });
});
