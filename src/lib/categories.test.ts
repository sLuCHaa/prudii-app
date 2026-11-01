import { describe, it, expect } from "vitest";
import i18n from "./i18n";
import de from "../locales/de.json";
import { visibleCategories, shownCategory, reasonText, isCategoryId } from "./categories";

describe("categories", () => {
  it("keeps builtin order and drops hidden ones", () => {
    expect(visibleCategories(["social", "promotions"])).toEqual(["important", "purchases", "notifications", "newsletters"]);
  });
  it("shows only known, visible categories", () => {
    expect(shownCategory("newsletters", [])).toBe("newsletters");
    expect(shownCategory("newsletters", ["newsletters"])).toBeNull();
    expect(shownCategory("steuern", [])).toBeNull();
    expect(shownCategory(null, [])).toBeNull();
    expect(isCategoryId("important")).toBe(true);
  });
  it("renders reasons with plural count", async () => {
    i18n.addResourceBundle("de", "translation", de, true, true);
    await i18n.changeLanguage("de");
    const t = i18n.t.bind(i18n);
    expect(reasonText(t, { code: "sent_to_sender", params: { sender: "anna.weber@studio-halde.example", count: "14" } }))
      .toBe("Du hast anna.weber@studio-halde.example 14-mal geschrieben");
    expect(reasonText(t, { code: "sent_to_sender", params: { sender: "anna.weber@studio-halde.example", count: "1" } }))
      .toBe("Du hast anna.weber@studio-halde.example schon einmal geschrieben");
    expect(reasonText(t, { code: "mailing_list", params: {} })).toBe("Kommt über eine Mailingliste");
  });
});
