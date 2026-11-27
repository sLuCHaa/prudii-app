import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import pt from "../locales/pt.json";
import ru from "../locales/ru.json";
import zh from "../locales/zh.json";

const KEYS = [
  "protocol", "host", "security", "ruleTitle", "mode.keep", "mode.afterFetch", "mode.afterDays", "days", "withLocal",
  "rule.keep", "rule.afterFetch", "rule.withLocal", "rule.withoutLocal", "rule.localOnly",
  "appPasswordGmail", "appPasswordFastmail", "enableHint", "enableLink", "testing",
  "serverSettingsDesc", "serverChangeHint", "deleteAccountBody",
  "error.noUidl.title", "error.noUidl.detail", "error.locked.title", "error.locked.detail",
  "error.tryLater.title", "error.tryLater.detail", "error.auth.generic", "error.auth.gmail",
  "error.auth.fastmail", "error.auth.enable", "error.protocolConflict", "error.accountExists", "error.protocolChange",
];

const PLURALS: Record<string, string[]> = {
  en: ["one", "other"],
  de: ["one", "other"],
  es: ["one", "other"],
  fr: ["one", "other"],
  pt: ["one", "other"],
  ru: ["one", "few", "many", "other"],
  zh: ["other"],
};

const PLACEHOLDERS: Record<string, string[]> = {
  enableHint: ["{{provider}}"],
  "error.auth.enable": ["{{provider}}"],
  "error.protocolConflict": ["{{email}}", "{{protocol}}"],
  "error.accountExists": ["{{email}}"],
};

const SENTENCES = KEYS.filter((k) => /^rule\.|^error\.|Hint$|Desc$|Body$|^appPassword/.test(k));

const read = (block: unknown, path: string) =>
  path.split(".").reduce<unknown>((node, k) => (node as Record<string, unknown> | undefined)?.[k], block);

describe("POP3 translations", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    const block = (data as Record<string, unknown>).pop3;
    const plurals = PLURALS[lang].map((s) => `rule.afterDays_${s}`);

    it(`${lang} has every POP3 text`, () => {
      const missing = [...KEYS, ...plurals].filter((k) => {
        const v = read(block, k);
        return typeof v !== "string" || !v.trim();
      });
      expect(missing).toEqual([]);
    });

    it(`${lang} keeps the placeholders`, () => {
      const wanted = { ...PLACEHOLDERS, ...Object.fromEntries(plurals.map((k) => [k, ["{{count}}"]])) };
      for (const [key, names] of Object.entries(wanted)) {
        for (const name of names) expect(String(read(block, key)), key).toContain(name);
      }
    });

    it(`${lang} points to the backup tab by its label`, () => {
      const { settings } = data as { settings: { title: string; tabs: { backup: string } } };
      expect(String(read(block, "deleteAccountBody"))).toContain(`${settings.title} → ${settings.tabs.backup}`);
    });

    if (lang !== "en") {
      it(`${lang} translates the sentences`, () => {
        const english = (en as Record<string, unknown>).pop3;
        expect(SENTENCES.filter((k) => read(block, k) === read(english, k))).toEqual([]);
      });
    }
  }
});
