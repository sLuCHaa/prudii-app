import { describe, it, expect } from "vitest";
import { normalizeLinkInput } from "./linkInput";
import en from "../../locales/en.json";
import de from "../../locales/de.json";
import es from "../../locales/es.json";
import fr from "../../locales/fr.json";
import pt from "../../locales/pt.json";
import ru from "../../locales/ru.json";
import zh from "../../locales/zh.json";

const ok = (href: string) => ({ ok: true, href });
const bad = (reason: string) => ({ ok: false, reason });

describe("normalizeLinkInput", () => {
  it("adds https to plain domains and keeps full web addresses", () => {
    expect(normalizeLinkInput("firma.de")).toEqual(ok("https://firma.de"));
    expect(normalizeLinkInput("  www.firma.de/pfad?x=1 ")).toEqual(ok("https://www.firma.de/pfad?x=1"));
    expect(normalizeLinkInput("https://firma.de")).toEqual(ok("https://firma.de"));
    expect(normalizeLinkInput("HTTP://Firma.de")).toEqual(ok("HTTP://Firma.de"));
    expect(normalizeLinkInput("firma.de:8080/x")).toEqual(ok("https://firma.de:8080/x"));
    expect(normalizeLinkInput("192.168.1.10")).toEqual(ok("https://192.168.1.10"));
  });

  it("turns email addresses into mailto links and checks them", () => {
    expect(normalizeLinkInput("max@firma.de")).toEqual(ok("mailto:max@firma.de"));
    expect(normalizeLinkInput("mailto:max@firma.de")).toEqual(ok("mailto:max@firma.de"));
    expect(normalizeLinkInput("mailto:max")).toEqual(bad("email"));
  });

  it("accepts phone links and drops their spacing", () => {
    expect(normalizeLinkInput("tel:+49 8441 47718-15")).toEqual(ok("tel:+4984414771815"));
    expect(normalizeLinkInput("tel:abc")).toEqual(bad("phone"));
  });

  it("rejects words that are not addresses", () => {
    expect(normalizeLinkInput("test")).toEqual(bad("domain"));
    expect(normalizeLinkInput("https://test")).toEqual(bad("domain"));
  });

  it("rejects spaces and unsafe or unknown schemes", () => {
    expect(normalizeLinkInput("firma .de")).toEqual(bad("spaces"));
    expect(normalizeLinkInput("https://firma.de/a b")).toEqual(bad("spaces"));
    expect(normalizeLinkInput("javascript:alert(1)")).toEqual(bad("scheme"));
    expect(normalizeLinkInput("data:text/html,x")).toEqual(bad("scheme"));
    expect(normalizeLinkInput("file:///c:/x")).toEqual(bad("scheme"));
  });

  it("reports an empty field", () => {
    expect(normalizeLinkInput("   ")).toEqual(bad("empty"));
  });
});

describe("link error texts", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    it(`${lang} explains every problem`, () => {
      const errors = (data as { compose?: { linkErrors?: Record<string, string> } }).compose?.linkErrors ?? {};
      expect(["spaces", "scheme", "domain", "email", "phone"].filter((k) => !errors[k]?.trim())).toEqual([]);
    });
  }
});
