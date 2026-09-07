import { describe, it, expect } from "vitest";
import { ACCENT_OPTIONS, DEFAULT_ACCENT_HEX, effectiveAccentHex, isAccentHex } from "./accents";

describe("ACCENT_OPTIONS", () => {
  it("lists the eight palette colours plus system, each with an i18n key", () => {
    expect(ACCENT_OPTIONS.map((o) => o.id)).toEqual(["blue", "purple", "green", "teal", "orange", "pink", "red", "amber", "system"]);
    for (const o of ACCENT_OPTIONS) expect(o.labelKey.startsWith("commandPalette.accent")).toBe(true);
    expect(ACCENT_OPTIONS.find((o) => o.id === "system")?.hex).toBeNull();
    expect(ACCENT_OPTIONS.find((o) => o.id === "blue")?.hex).toBe(DEFAULT_ACCENT_HEX);
  });
});

describe("effectiveAccentHex", () => {
  it("returns the palette hex for named accents", () => {
    expect(effectiveAccentHex("red", null)).toBe("#ef4444");
  });
  it("returns the OS hex for system, falling back to blue when unknown", () => {
    expect(effectiveAccentHex("system", "#112233")).toBe("#112233");
    expect(effectiveAccentHex("system", null)).toBe(DEFAULT_ACCENT_HEX);
    expect(effectiveAccentHex("system", "garbage")).toBe(DEFAULT_ACCENT_HEX);
  });
});

describe("isAccentHex", () => {
  it("accepts only #rrggbb", () => {
    expect(isAccentHex("#3b82f6")).toBe(true);
    expect(isAccentHex("#3B82F6")).toBe(true);
    expect(isAccentHex("#fff")).toBe(false);
    expect(isAccentHex("3b82f6")).toBe(false);
    expect(isAccentHex(null)).toBe(false);
  });
});
