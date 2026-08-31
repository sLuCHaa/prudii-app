import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import i18n from "./i18n";
import de from "../locales/de.json";
import { formatMailDate, formatDateTime, formatTime } from "./dateUtils";

// Fixed "now" so today/yesterday buckets are deterministic. Assertions avoid
// exact clock times — the runner's timezone shifts rendered hours.
const NOW = new Date("2026-03-15T12:00:00Z");

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(async () => {
  vi.useRealTimers();
  await i18n.changeLanguage("en");
});

describe("formatMailDate", () => {
  it("renders a time for today's mail", () => {
    expect(formatMailDate("2026-03-15T10:00:00Z", true)).toMatch(/^\d{1,2}:\d{2}$/);
  });

  it("uses am/pm when 24h clock is off", () => {
    expect(formatMailDate("2026-03-15T10:00:00Z", false).toLowerCase()).toMatch(/am|pm/);
  });

  it("labels yesterday in the UI language", async () => {
    expect(formatMailDate("2026-03-14T10:00:00Z", true)).toBe("Yesterday");

    i18n.addResourceBundle("de", "translation", de, true, true);
    await i18n.changeLanguage("de");
    expect(formatMailDate("2026-03-14T10:00:00Z", true)).toBe("Gestern");
  });

  it("orders day and month per locale for older mail", async () => {
    const en = formatMailDate("2026-01-05T10:00:00Z", true);
    expect(en).toBe("Jan 5");

    i18n.addResourceBundle("de", "translation", de, true, true);
    await i18n.changeLanguage("de");
    const deOut = formatMailDate("2026-01-05T10:00:00Z", true);
    expect(deOut.startsWith("5")).toBe(true);
  });

  it("returns the raw string for garbage input", () => {
    expect(formatMailDate("not-a-date", true)).toBe("not-a-date");
  });
});

describe("formatDateTime", () => {
  it("contains the year and no hardcoded English connector", () => {
    const out = formatDateTime(new Date("2026-03-10T10:00:00Z"), true);
    expect(out).toContain("2026");
    expect(out).not.toContain(" at ");
  });

  it("returns empty string for invalid dates", () => {
    expect(formatDateTime(new Date("invalid"), true)).toBe("");
  });
});

describe("formatTime", () => {
  it("respects the 24h setting", () => {
    const date = new Date("2026-03-15T18:30:00Z");
    expect(formatTime(date, true)).toMatch(/^\d{1,2}:\d{2}$/);
    expect(formatTime(date, false).toLowerCase()).toMatch(/am|pm/);
  });
});
