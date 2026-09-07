import { describe, it, expect } from "vitest";
import { prefers24HourClock, weekStartsOn } from "./localeDefaults";

describe("prefers24HourClock", () => {
  it("follows the locale's hour cycle", () => {
    expect(prefers24HourClock("en-US")).toBe(false);
    expect(prefers24HourClock("de-DE")).toBe(true);
    expect(prefers24HourClock("en-GB")).toBe(true);
    expect(prefers24HourClock("ja-JP")).toBe(true);
  });

  it("falls back to 24h on garbage", () => {
    expect(prefers24HourClock("not a locale!!")).toBe(true);
  });
});

describe("weekStartsOn", () => {
  it("returns date-fns day indexes per region", () => {
    expect(weekStartsOn("en-US")).toBe(0);
    expect(weekStartsOn("de-DE")).toBe(1);
    expect(weekStartsOn("fr-FR")).toBe(1);
    expect(weekStartsOn("ar-EG")).toBe(6);
  });

  it("falls back to Monday on garbage", () => {
    expect(weekStartsOn("not a locale!!")).toBe(1);
  });
});
