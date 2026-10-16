import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import pt from "../locales/pt.json";
import ru from "../locales/ru.json";
import zh from "../locales/zh.json";

const KEYS = ["title", "subtitle", "later", "install", "loading", "verifying", "restarting", "retry"];

describe("updateBanner translations", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    it(`${lang} has every banner text`, () => {
      const block = (data as Record<string, unknown>).updateBanner as Record<string, unknown> | undefined;
      expect(KEYS.filter((k) => typeof block?.[k] !== "string" || !(block[k] as string).trim())).toEqual([]);
      expect(block?.loading).toContain("{{pct}}");
    });
  }
});
