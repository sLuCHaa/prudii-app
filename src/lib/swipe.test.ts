import { describe, it, expect } from "vitest";
import { accumulate, decide, isHorizontalIntent, SWIPE_TRIGGER_PX, SWIPE_MAX_PX } from "./swipe";

describe("swipe", () => {
  it("accumulates against the wheel direction and clamps", () => {
    expect(accumulate(0, -30)).toBe(30);
    expect(accumulate(120, -30)).toBe(SWIPE_MAX_PX);
    expect(accumulate(-120, 30)).toBe(-SWIPE_MAX_PX);
  });

  it("decides only past the trigger threshold", () => {
    expect(decide(SWIPE_TRIGGER_PX - 1)).toBeNull();
    expect(decide(SWIPE_TRIGGER_PX)).toBe("archive");
    expect(decide(-SWIPE_TRIGGER_PX)).toBe("trash");
    expect(decide(0)).toBeNull();
  });

  it("only claims clearly horizontal gestures", () => {
    expect(isHorizontalIntent(20, 5)).toBe(true);
    expect(isHorizontalIntent(6, 40)).toBe(false);
    expect(isHorizontalIntent(2, 0)).toBe(false);
  });
});
