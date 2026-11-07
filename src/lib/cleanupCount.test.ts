import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import pt from "../locales/pt.json";
import ru from "../locales/ru.json";
import zh from "../locales/zh.json";
import { cleanupCount, formatCleanupCount, isCleanupFolder } from "./cleanupCount";

describe("cleanupCount", () => {
  it("shows how many mails are left in spam and trash", () => {
    expect(cleanupCount({ folder_type: "spam", total_count: 248 }, true)).toBe(248);
    expect(cleanupCount({ folder_type: "trash", total_count: 1204 }, true)).toBe(1204);
  });

  it("shows nothing for an empty folder", () => {
    expect(cleanupCount({ folder_type: "trash", total_count: 0 }, true)).toBe(0);
  });

  it("shows nothing when the setting is off", () => {
    expect(cleanupCount({ folder_type: "spam", total_count: 248 }, false)).toBe(0);
  });

  it("leaves every other folder alone", () => {
    for (const folder_type of ["inbox", "sent", "drafts", "archive", "custom"]) {
      expect(cleanupCount({ folder_type, total_count: 50 }, true)).toBe(0);
    }
  });

  it("never shows a negative count", () => {
    expect(cleanupCount({ folder_type: "spam", total_count: -3 }, true)).toBe(0);
  });
});

describe("isCleanupFolder", () => {
  it("is true only for spam and trash", () => {
    expect(isCleanupFolder("spam")).toBe(true);
    expect(isCleanupFolder("trash")).toBe(true);
    expect(isCleanupFolder("inbox")).toBe(false);
  });
});

describe("formatCleanupCount", () => {
  it("groups thousands the way the UI language does", () => {
    expect(formatCleanupCount(1204, "de")).toBe("1.204");
    expect(formatCleanupCount(1204, "en")).toBe("1,204");
    expect(formatCleanupCount(248, "de")).toBe("248");
  });
});

describe("cleanup count setting translations", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    it(`${lang} names and explains the setting`, () => {
      const block = ((data as Record<string, unknown>).settings as Record<string, unknown>)
        .appSettings as Record<string, unknown>;
      const missing = ["showCleanupCounts", "showCleanupCountsDesc"].filter(
        (k) => typeof block[k] !== "string" || !(block[k] as string).trim(),
      );
      expect(missing).toEqual([]);
    });
  }
});
