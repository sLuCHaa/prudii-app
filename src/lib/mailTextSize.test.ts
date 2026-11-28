import { describe, it, expect } from "vitest";
import { DEFAULT_MAIL_TEXT_SIZE, mailTextScale, normalizeMailTextSize } from "./mailTextSize";

describe("normalizeMailTextSize", () => {
  it("keeps the offered sizes", () => {
    for (const size of [100, 115, 130, 150]) expect(normalizeMailTextSize(size)).toBe(size);
  });

  it("falls back to the default for anything else", () => {
    for (const bad of [0, 99, 120, 200, -1, NaN, "130", null, undefined, {}]) {
      expect(normalizeMailTextSize(bad)).toBe(DEFAULT_MAIL_TEXT_SIZE);
    }
  });
});

describe("mailTextScale", () => {
  it("turns percent into a factor", () => {
    expect(mailTextScale(100)).toBe(1);
    expect(mailTextScale(115)).toBeCloseTo(1.15);
    expect(mailTextScale(150)).toBe(1.5);
  });

  it("is 1 for invalid values", () => {
    expect(mailTextScale(undefined)).toBe(1);
    expect(mailTextScale(77)).toBe(1);
  });
});
