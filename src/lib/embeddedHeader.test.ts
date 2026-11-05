import { describe, it, expect } from "vitest";
import { headerLabel, parseAddressList, parseHeaderDate, isHeaderSeparator } from "./embeddedHeader";

describe("headerLabel", () => {
  it("reads each label in German and English", () => {
    const value = "Lea Kraus <lea@studio-halde.example>";
    expect(headerLabel(`Von: ${value}`)).toEqual({ field: "from", value });
    expect(headerLabel("Gesendet: Freitag")).toEqual({ field: "date", value: "Freitag" });
    expect(headerLabel("Sent: Friday")).toEqual({ field: "date", value: "Friday" });
    expect(headerLabel("Datum: Freitag")).toEqual({ field: "date", value: "Freitag" });
    expect(headerLabel("An: Jonas")).toEqual({ field: "to", value: "Jonas" });
    expect(headerLabel("To: Jonas")).toEqual({ field: "to", value: "Jonas" });
    expect(headerLabel("Cc: Anna")).toEqual({ field: "cc", value: "Anna" });
    expect(headerLabel("Betreff: Termin")).toEqual({ field: "subject", value: "Termin" });
    expect(headerLabel("Subject: Termin")).toEqual({ field: "subject", value: "Termin" });
    expect(headerLabel("Von : Lea")).toEqual({ field: "from", value: "Lea" });
    expect(headerLabel("Cc:")).toEqual({ field: "cc", value: "" });
    expect(headerLabel("Vonsonsten gut")).toBeNull();
    expect(headerLabel("Hallo Lea,")).toBeNull();
  });
});

describe("parseAddressList", () => {
  const lea = { name: "Lea Kraus", email: "lea@studio-halde.example" };

  it("parses address shapes", () => {
    expect(parseAddressList("Lea Kraus <lea@studio-halde.example>")).toEqual([lea]);
    expect(parseAddressList('"Kraus, Lea" <lea@studio-halde.example>')).toEqual([{ name: "Kraus, Lea", email: lea.email }]);
    expect(parseAddressList("Lea Kraus [mailto:lea@studio-halde.example]")).toEqual([lea]);
    expect(parseAddressList("lea@studio-halde.example")).toEqual([{ name: "", email: lea.email }]);
    expect(parseAddressList("Lea Kraus")).toEqual([{ name: "Lea Kraus", email: "" }]);
    expect(parseAddressList("")).toEqual([]);
  });

  it("splits lists on semicolons and on commas outside quotes", () => {
    const jonas = { name: "Jonas Berger", email: "jonas@studio-halde.example" };
    const anna = { name: "", email: "anna@studio-halde.example" };
    expect(parseAddressList("Jonas Berger <jonas@studio-halde.example>; anna@studio-halde.example")).toEqual([jonas, anna]);
    expect(parseAddressList('"Berger, Jonas" <jonas@studio-halde.example>, anna@studio-halde.example')).toEqual([
      { name: "Berger, Jonas", email: jonas.email },
      anna,
    ]);
  });

  it("keeps the address of a Nachname, Vorname sender and recipient list", () => {
    expect(parseAddressList("Kraus, Lea <lea.kraus@studio-halde.example>")).toEqual([{ name: "Kraus, Lea", email: "lea.kraus@studio-halde.example" }]);
    expect(parseAddressList("Berger, Jonas <jonas.berger@studio-halde.example>; Weber, Anna <anna.weber@studio-halde.example>")).toEqual([
      { name: "Berger, Jonas", email: "jonas.berger@studio-halde.example" },
      { name: "Weber, Anna", email: "anna.weber@studio-halde.example" },
    ]);
    expect(parseAddressList("Lea Kraus, Jonas Berger")).toHaveLength(2);
  });

  it("drops the single quotes Outlook puts around a name, not an apostrophe", () => {
    expect(parseAddressList("'Studio Halde | Anna' <anna.weber@studio-halde.example>")).toEqual([
      { name: "Studio Halde | Anna", email: "anna.weber@studio-halde.example" },
    ]);
    expect(parseAddressList("Lea O'Neill <lea@studio-halde.example>")).toEqual([{ name: "Lea O'Neill", email: "lea@studio-halde.example" }]);
  });
});

describe("parseHeaderDate", () => {
  const local = (s: string) => {
    const d = new Date(s);
    return [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes()];
  };

  it("parses header dates", () => {
    for (const text of [
      "Freitag, 12. September 2026 22:22",
      "Friday, September 12, 2026 10:22 PM",
      "Fr., 12. Sept. 2026 um 22:22 Uhr",
      "Fri, Sep 12, 2026 at 10:22 PM",
      "12.09.2026 um 22:22",
      "12. September 2026 um 22:22:13 MESZ",
    ]) {
      expect(local(parseHeaderDate(text)), text).toEqual([2026, 9, 12, 22, 22]);
    }
  });

  it("reads slashed dates day first unless the numbers or a 12-hour clock say month first", () => {
    expect(local(parseHeaderDate("21/10/2026, 17:28:44"))).toEqual([2026, 10, 21, 17, 28]);
    expect(local(parseHeaderDate("10/21/2026, 5:28:44 PM"))).toEqual([2026, 10, 21, 17, 28]);
    expect(local(parseHeaderDate("03/04/2026, 17:28:44"))).toEqual([2026, 4, 3, 17, 28]);
    expect(local(parseHeaderDate("3/4/2026, 5:28:44 PM"))).toEqual([2026, 3, 4, 17, 28]);
  });

  it("honours an explicit numeric zone", () => {
    const text = "Fri, 12 Sep 2026 22:22:00 +0200";
    expect(new Date(parseHeaderDate(text)).getTime()).toBe(Date.parse(text));
  });

  it("returns the trimmed input when it does not understand the date", () => {
    expect(parseHeaderDate("  irgendwann nächste Woche ")).toBe("irgendwann nächste Woche");
  });
});

describe("isHeaderSeparator", () => {
  it("knows separators", () => {
    for (const line of [
      "---------- Forwarded message ---------",
      "-------- Weitergeleitete Nachricht --------",
      "Anfang der weitergeleiteten Nachricht:",
      "Begin forwarded message:",
      "-----Ursprüngliche Nachricht-----",
      "________________________________",
    ]) {
      expect(isHeaderSeparator(line), line).toBe(true);
    }
    expect(isHeaderSeparator("-- ")).toBe(false);
    expect(isHeaderSeparator("Viele Grüße")).toBe(false);
  });
});
