import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import pt from "../locales/pt.json";
import ru from "../locales/ru.json";
import zh from "../locales/zh.json";

const KEYS = [
  "sidebar.mailboxCheck",
  "mailboxCheck.title",
  "mailboxCheck.period",
  "mailboxCheck.local",
  "mailboxCheck.allAccounts",
  "mailboxCheck.scanning",
  "mailboxCheck.tiles.newsletters",
  "mailboxCheck.tiles.newslettersText_other",
  "mailboxCheck.tiles.trackers",
  "mailboxCheck.tiles.trackersText_other",
  "mailboxCheck.tiles.unsubscribed",
  "mailboxCheck.tiles.blockedText_other",
  "mailboxCheck.list.title",
  "mailboxCheck.list.subtitle",
  "mailboxCheck.list.sender",
  "mailboxCheck.list.volume",
  "mailboxCheck.list.read",
  "mailboxCheck.list.trackers",
  "mailboxCheck.list.action",
  "mailboxCheck.list.mails_other",
  "mailboxCheck.list.readOf",
  "mailboxCheck.list.last",
  "mailboxCheck.list.trackerChip_other",
  "mailboxCheck.list.noTracker",
  "mailboxCheck.list.showAll",
  "mailboxCheck.list.empty",
  "mailboxCheck.trackers.title",
  "mailboxCheck.trackers.explain",
  "mailboxCheck.trackers.byCompany",
  "mailboxCheck.trackers.other",
  "mailboxCheck.trackers.bySender",
  "mailboxCheck.trackers.none",
  "mailboxCheck.trackers.footnote",
  "mailboxCheck.hint.title",
  "mailboxCheck.hint.text",
  "mailboxCheck.hint.open",
];

function lookup(data: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown> | undefined)?.[part], data);
}

describe("inbox check translations", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    it(`${lang} has every inbox check text`, () => {
      expect(KEYS.filter((k) => typeof lookup(data, k) !== "string" || !(lookup(data, k) as string).trim())).toEqual([]);
    });
  }
});
