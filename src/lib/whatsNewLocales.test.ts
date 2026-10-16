import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import pt from "../locales/pt.json";
import ru from "../locales/ru.json";
import zh from "../locales/zh.json";
import { RELEASES } from "./whatsNew";

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

const required = [
  "whatsNew.title",
  "whatsNew.subtitle",
  "whatsNew.done",
  ...RELEASES.flatMap((r) => r.items.flatMap((i) => [`${i.key}.title`, `${i.key}.text`])),
];

describe("whatsNew translations", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    it(`${lang} has every whatsNew text`, () => {
      expect(required.filter((k) => typeof get(data, k) !== "string" || !(get(data, k) as string).trim())).toEqual([]);
    });
  }

  it("keeps the version placeholder in every title", () => {
    for (const data of [en, de, es, fr, pt, ru, zh]) expect(get(data, "whatsNew.title")).toContain("{{version}}");
  });
});
