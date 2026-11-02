import { describe, it, expect } from "vitest";
import { markDocument, searchTerms, splitMatches, termPattern } from "./searchHighlight";

describe("searchTerms", () => {
  it("splits like the backend and drops quotes, addresses and single letters", () => {
    expect(searchTerms('Rechnung "Studio Halde" anna@studio-halde.example x')).toEqual(["rechnung", "studio", "halde"]);
  });

  it("dedupes case-insensitively, longest first", () => {
    expect(searchTerms("Hafen hafenweg HAFEN")).toEqual(["hafenweg", "hafen"]);
  });
});

describe("splitMatches", () => {
  it("marks every case-insensitive hit and keeps the text around it", () => {
    const parts = splitMatches("Die Rechnung für Studio Halde", termPattern(["rechnung", "halde"]));
    expect(parts).toEqual([
      { text: "Die ", hit: false },
      { text: "Rechnung", hit: true },
      { text: " für Studio ", hit: false },
      { text: "Halde", hit: true },
    ]);
  });

  it("treats regex characters in terms literally", () => {
    expect(splitMatches("Preis (netto) 3.50", termPattern(["(netto)", "3.50"])).filter((p) => p.hit).map((p) => p.text)).toEqual(["(netto)", "3.50"]);
  });

  it("returns the text untouched without terms", () => {
    expect(splitMatches("Hallo", null)).toEqual([{ text: "Hallo", hit: false }]);
  });
});

describe("markDocument", () => {
  it("wraps hits outside scripts and styles and can be repainted", () => {
    const doc = document.implementation.createHTMLDocument("");
    doc.body.innerHTML = "<p>Rechnung vom Hafenweg</p><style>.rechnung{}</style><p>Keine rechnung</p>";
    expect(markDocument(doc, termPattern(["rechnung"]))).toBe(2);
    expect(doc.querySelector("style")!.textContent).toBe(".rechnung{}");
    expect(markDocument(doc, termPattern(["hafenweg"]))).toBe(1);
    expect(doc.querySelectorAll("mark").length).toBe(1);
    expect(markDocument(doc, null)).toBe(0);
    expect(doc.body.innerHTML).toBe("<p>Rechnung vom Hafenweg</p><style>.rechnung{}</style><p>Keine rechnung</p>");
  });
});
