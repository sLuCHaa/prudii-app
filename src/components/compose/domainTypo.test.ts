import { describe, it, expect } from "vitest";
import { domainOf, suggestDomain, withDomain } from "./domainTypo";

const known = (...extra: string[]) => ({ known: new Set(extra), candidates: extra });

describe("suggestDomain", () => {
  it("catches swapped and missing letters in the big providers", () => {
    const k = known();
    expect(suggestDomain("gmial.com", k)).toBe("gmail.com");
    expect(suggestDomain("t-onlien.de", k)).toBe("t-online.de");
    expect(suggestDomain("outlok.de", k)).toBe("outlook.de");
    expect(suggestDomain("gmail.con", k)).toBe("gmail.com");
  });

  it("catches typos in the domains of your contacts", () => {
    expect(suggestDomain("studio-hald.de", known("studio-halde.de"))).toBe("studio-halde.de");
  });

  it("leaves domains alone that you already write to", () => {
    expect(suggestDomain("gmail.co", known("gmail.co"))).toBeNull();
    expect(suggestDomain("studio-halde.de", known("studio-halde.de"))).toBeNull();
  });

  it("does not take a real country domain for a typo", () => {
    expect(suggestDomain("gmx.it", known())).toBeNull();
    expect(suggestDomain("web.at", known())).toBeNull();
    expect(suggestDomain("roboforex.ru", known("roboforex.eu"))).toBeNull();
  });

  it("stays quiet for unrelated or ambiguous domains", () => {
    expect(suggestDomain("studio-halde.de", known())).toBeNull();
    expect(suggestDomain("abcd.de", known("abce.de", "abcf.de"))).toBeNull();
  });

  it("takes only a single slip for a typo", () => {
    expect(suggestDomain("komoot.de", known("komdat.de"))).toBeNull();
    expect(suggestDomain("soundcloud.com", known("sendcloud.com"))).toBeNull();
  });

  it("accepts only swapped letters in very short names", () => {
    expect(suggestDomain("wbe.de", known())).toBe("web.de");
    expect(suggestDomain("esn.com", known())).toBeNull();
  });

  it("never mixes up domains of the same organisation", () => {
    expect(suggestDomain("klarna.com", known("e.klarna.com"))).toBeNull();
    expect(suggestDomain("relay01.netcup.net", known("relay02.netcup.net"))).toBeNull();
    expect(suggestDomain("my.vorwerk.com", known("mkt.vorwerk.com"))).toBeNull();
  });
});

describe("domainOf / withDomain", () => {
  it("reads and swaps the domain of a chip with or without a name", () => {
    expect(domainOf("Anna Weber <Anna@GMIAL.com>")).toBe("gmial.com");
    expect(withDomain("Anna Weber <Anna@GMIAL.com>", "gmail.com")).toBe("Anna Weber <Anna@gmail.com>");
    expect(withDomain("anna@gmial.com", "gmail.com")).toBe("anna@gmail.com");
  });
});
