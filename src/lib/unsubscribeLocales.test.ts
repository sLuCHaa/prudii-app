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
  "block",
  "dialogTitle",
  "dialogMessage",
  "blockDialogTitle",
  "blockDialogMessage",
  "trashExisting",
  "confirm",
  "confirmBlock",
  "allowAgain",
  "retry",
  "allowAgainTitle",
  "allowAgainMessage",
  "status.stillSendingSpared",
  "movedToTrash_other",
  "status.waiting",
  "status.webPending",
  "status.quiet_other",
  "status.stillSending_other",
  "status.blocked_other",
  "errors.failed",
  "errors.noTarget",
  "errors.spam",
];

function lookup(block: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], block);
}

describe("unsubscribe translations", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    it(`${lang} has every unsubscribe text`, () => {
      const block = (data as Record<string, unknown>).unsubscribe;
      expect(KEYS.filter((k) => typeof lookup(block, k) !== "string" || !(lookup(block, k) as string).trim())).toEqual([]);
      expect(lookup(block, "successMessage")).toBeUndefined();
    });
  }
});
