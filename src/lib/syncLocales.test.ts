import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import pt from "../locales/pt.json";
import ru from "../locales/ru.json";
import zh from "../locales/zh.json";

const KEYS = ["connecting", "folders", "prefetching"];

describe("sync status translations", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    it(`${lang} has every sync status text`, () => {
      const block = (data as Record<string, unknown>).sync as Record<string, unknown> | undefined;
      expect(KEYS.filter((k) => typeof block?.[k] !== "string" || !(block[k] as string).trim())).toEqual([]);
    });
  }
});
