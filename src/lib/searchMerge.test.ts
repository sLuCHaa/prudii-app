import { describe, it, expect } from "vitest";
import en from "../locales/en.json";
import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import pt from "../locales/pt.json";
import ru from "../locales/ru.json";
import zh from "../locales/zh.json";
import type { SearchResult } from "../types";
import { mergeSearchResults } from "./searchMerge";

const hit = (mail_id: string, date: string, snippet = ""): SearchResult => ({
  mail_id, subject: mail_id, snippet, from_name: "", from_email: "", date,
  folder_id: "f", folder_name: "Inbox", is_read: true, has_attachments: false, rank: 0,
});

describe("mergeSearchResults", () => {
  it("adds the server hits the local index missed, newest first", () => {
    const merged = mergeSearchResults(
      [hit("a", "2026-01-02")],
      [hit("b", "2026-01-03"), hit("c", "2026-01-01")],
    );
    expect(merged?.map((h) => h.mail_id)).toEqual(["b", "a", "c"]);
  });

  it("keeps the local hit, with its highlighted snippet, when both found a mail", () => {
    const merged = mergeSearchResults(
      [hit("a", "2026-01-02", "[[hl]]walrus[[/hl]]")],
      [hit("a", "2026-01-02", "plain preview")],
    );
    expect(merged).toHaveLength(1);
    expect(merged?.[0].snippet).toBe("[[hl]]walrus[[/hl]]");
  });

  it("works while the server has not answered yet", () => {
    expect(mergeSearchResults([hit("a", "2026-01-02")], undefined)?.map((h) => h.mail_id)).toEqual(["a"]);
    expect(mergeSearchResults(undefined, undefined)).toBeUndefined();
  });

  it("caps the list", () => {
    const many = Array.from({ length: 150 }, (_, i) => hit(`r${i}`, `2026-01-01T00:${String(i % 60).padStart(2, "0")}`));
    expect(mergeSearchResults([], many, 100)).toHaveLength(100);
  });
});

describe("server search translations", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    it(`${lang} says that the provider is searched too`, () => {
      const block = (data as Record<string, unknown>).search as Record<string, unknown>;
      expect(typeof block.searchingServer === "string" && (block.searchingServer as string).trim()).toBeTruthy();
    });
  }
});
