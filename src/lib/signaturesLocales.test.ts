import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import pt from "../locales/pt.json";
import ru from "../locales/ru.json";
import zh from "../locales/zh.json";

const KEYS = [
  "title",
  "description",
  "new",
  "edit",
  "name",
  "nameRequired",
  "unassigned",
  "usedBy",
  "usedByDesc",
  "usesOther",
  "duplicate",
  "copyName",
  "delete",
  "deleteConfirm",
  "deleteConfirmUsed",
  "empty",
  "saveFailed",
  "deleteFailed",
  "duplicateFailed",
];

type Block = Record<string, unknown> | undefined;
const missing = (block: Block, keys: string[]) => keys.filter((k) => typeof block?.[k] !== "string" || !(block[k] as string).trim());

describe("signature list translations", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    const root = data as Record<string, unknown>;
    const settings = root.settings as Record<string, Block>;

    it(`${lang} has every text of the signature list`, () => {
      expect(missing(root.signatures as Block, KEYS)).toEqual([]);
    });

    it(`${lang} names the tab`, () => {
      expect(missing(settings.tabs, ["signatures"])).toEqual([]);
    });

    it(`${lang} has the texts for picking a signature in an account`, () => {
      expect(missing(settings.account, ["signatureSelect", "signatureNone", "signatureSharedWith", "signatureEditInTab"])).toEqual([]);
      expect((settings.account as Record<string, string>).signatureSharedWith ?? "").toContain("{{accounts}}");
    });

    it(`${lang} keeps the placeholders`, () => {
      const block = root.signatures as Record<string, string>;
      for (const key of ["usesOther", "copyName", "deleteConfirm", "deleteConfirmUsed"]) {
        expect(block?.[key] ?? "").toContain("{{name}}");
      }
      expect(block?.deleteConfirmUsed ?? "").toContain("{{accounts}}");
    });
  }
});
