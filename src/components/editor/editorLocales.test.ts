import { describe, it, expect } from "vitest";
import en from "../../locales/en.json";
import de from "../../locales/de.json";
import es from "../../locales/es.json";
import fr from "../../locales/fr.json";
import pt from "../../locales/pt.json";
import ru from "../../locales/ru.json";
import zh from "../../locales/zh.json";

const KEYS = [
  "compose.toolbar.bold",
  "compose.toolbar.italic",
  "compose.toolbar.underline",
  "compose.toolbar.strike",
  "compose.toolbar.clearFormatting",
  "compose.toolbar.bulletList",
  "compose.toolbar.orderedList",
  "compose.toolbar.quote",
  "compose.toolbar.codeBlock",
  "compose.toolbar.undo",
  "compose.toolbar.redo",
  "compose.linkText",
  "compose.linkTextPlaceholder",
  "shortcuts.desc.insertLink",
];

function lookup(data: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => (node as Record<string, unknown> | undefined)?.[key], data);
}

describe("editor texts", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    it(`${lang} names every toolbar action and the link text field`, () => {
      expect(KEYS.filter((k) => typeof lookup(data, k) !== "string" || !(lookup(data, k) as string).trim())).toEqual([]);
    });
  }
});
