import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import pt from "../locales/pt.json";
import ru from "../locales/ru.json";
import zh from "../locales/zh.json";

const PLURAL = /_(zero|one|two|few|many|other)$/;

function keys(obj: unknown, prefix: string): string[] {
  if (obj && typeof obj === "object") {
    return Object.entries(obj as Record<string, unknown>).flatMap(([k, v]) => keys(v, prefix ? `${prefix}.${k}` : k));
  }
  return [prefix];
}

// Plural forms differ per language (ru has few/many, zh only other); compare the base keys.
function baseKeys(obj: unknown, prefix: string): Set<string> {
  return new Set(keys(obj, prefix).map((k) => k.replace(PLURAL, "")));
}

const EXTRA = [
  "sidebar.calendar",
  "settings.tabs.calendar",
  "shortcuts.calendar",
  "shortcuts.desc.openCalendar",
  "shortcuts.desc.newEvent",
  "shortcuts.desc.calendarPrevNext",
  "shortcuts.desc.calendarToday",
  "shortcuts.desc.calendarViews",
];

describe("calendar translations", () => {
  const required = [...baseKeys(en.calendar, "calendar"), ...EXTRA];

  it("English has the entry keys", () => {
    const have = baseKeys(en, "");
    expect(EXTRA.filter((k) => !have.has(k))).toEqual([]);
  });

  for (const [lang, data] of Object.entries({ de, es, fr, pt, ru, zh })) {
    it(`${lang} has every calendar key`, () => {
      const have = baseKeys(data, "");
      expect(required.filter((k) => !have.has(k))).toEqual([]);
    });
  }
});
