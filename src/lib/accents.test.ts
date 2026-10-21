import { describe, it, expect, afterEach } from "vitest";
import { ACCENT_OPTIONS, DEFAULT_ACCENT_HEX, currentAccentHex, effectiveAccentHex, isAccentHex } from "./accents";

describe("currentAccentHex", () => {
  afterEach(() => document.documentElement.style.removeProperty("--c-accent"));

  it("reads the accent the window shows", () => {
    document.documentElement.style.setProperty("--c-accent", "#10b981");
    expect(currentAccentHex()).toBe("#10b981");
  });

  it("falls back to the default accent without a usable value", () => {
    expect(currentAccentHex()).toBe(DEFAULT_ACCENT_HEX);
  });
});

describe("ACCENT_OPTIONS", () => {
  it("lists the nine palette colours plus system, each with an i18n key", () => {
    expect(ACCENT_OPTIONS.map((o) => o.id)).toEqual(["terracotta", "blue", "purple", "green", "teal", "orange", "pink", "red", "amber", "system"]);
    for (const o of ACCENT_OPTIONS) expect(o.labelKey.startsWith("commandPalette.accent")).toBe(true);
    expect(ACCENT_OPTIONS.find((o) => o.id === "system")?.hex).toBeNull();
    expect(ACCENT_OPTIONS.find((o) => o.id === "terracotta")?.hex).toBe(DEFAULT_ACCENT_HEX);
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
