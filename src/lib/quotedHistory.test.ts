import { describe, it, expect } from "vitest";
import { stripQuotedHtml, stripQuotedText, isForwardSubject } from "./quotedHistory";

function expectStripped(html: string, kept: string[], dropped: string[]) {
  const out = stripQuotedHtml(html);
  expect(out).not.toBeNull();
  for (const k of kept) expect(out).toContain(k);
  for (const d of dropped) expect(out).not.toContain(d);
}

describe("stripQuotedHtml", () => {
  it("drops a Gmail quote container with its attribution", () => {
    expectStripped(
      '<div dir="ltr">Danke, passt!</div><br><div class="gmail_quote gmail_quote_container"><div dir="ltr" class="gmail_attr">Am Mo., 12. Okt. 2026 um 11:02 Uhr schrieb Anna &lt;a@b.de&gt;:<br></div><blockquote class="gmail_quote">Hallo Jonas</blockquote></div>',
      ["Danke, passt!"],
      ["schrieb Anna", "Hallo Jonas"],
    );
  });

  it("cuts an Outlook web reply from the separator to the end", () => {
    expectStripped(
      '<div>Klingt gut.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg" dir="ltr"><b>Von:</b> Anna<br><b>Gesendet:</b> Montag</div><div>Ursprünglicher Text</div>',
      ["Klingt gut."],
      ["Von:", "Ursprünglicher Text", "<hr"],
    );
  });

  it("cuts an Outlook desktop reply at the bordered header block", () => {
    expectStripped(
      '<div class="WordSection1"><p>Danke!</p><p>&nbsp;</p><div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm"><p><b>Von:</b> Anna Berger<br><b>Gesendet:</b> Montag</p></div></div><p>&nbsp;</p><p>Hallo Jonas</p></div>',
      ["Danke!"],
      ["Von:", "Hallo Jonas"],
    );
  });

  it("drops a Thunderbird cite prefix with its blockquote", () => {
    expectStripped(
      '<p>Passt.</p><div class="moz-cite-prefix">Am 12.10.26 um 11:02 schrieb Anna Berger:<br></div><blockquote type="cite">Hallo</blockquote>',
      ["Passt."],
      ["schrieb Anna", "Hallo"],
    );
  });

  it("drops an Apple Mail cite blockquote", () => {
    expectStripped(
      '<div>Super<br><div><br><blockquote type="cite"><div>Am 12.10.2026 um 11:02 schrieb Anna &lt;a@b.de&gt;:</div><br><div>Hallo</div></blockquote></div></div>',
      ["Super"],
      ["schrieb Anna", "Hallo"],
    );
  });

  it("drops a plain blockquote that follows an attribution line, as Prudii writes it", () => {
    expectStripped(
      "<p>Danke dir!</p><p>Am 12.10.2026, 11:02:00 schrieb Anna &lt;a@b.de&gt;:</p><blockquote><p>Hallo</p></blockquote><p><br></p>",
      ["Danke dir!"],
      ["schrieb Anna", "Hallo"],
    );
  });

  it("recognises Prudii's attribution in the other languages", () => {
    for (const intro of [
      "Le 12/10/2026 11:02:00, Anna a écrit :",
      "El 12/10/2026, 11:02:00, Anna escribió:",
      "Em 12/10/2026, 11:02:00, Anna escreveu:",
      "12.10.2026, 11:02:00 Anna написал(а):",
      "在 2026/10/12 11:02:00，Anna 写道：",
    ]) {
      expectStripped(`<p>Ok</p><p>${intro}</p><blockquote>Alt</blockquote>`, ["Ok"], ["Alt"]);
    }
  });

  it("finds an attribution split over inline nodes, as HubSpot writes it", () => {
    expectStripped(
      '<p>Danke</p><div class="hs_reply"><br><div>On Thu, May 28, 2026 at 2:35 PM, Ben <span dir="ltr">&lt;<a href="mailto:support@example.com">support@example.com</a>&gt;</span> wrote: <br><blockquote class="hs_reply_quote">Alter Text</blockquote></div></div>',
      ["Danke"],
      ["wrote", "Alter Text"],
    );
  });

  it("finds the attribution in front of a wrapper around the quote, as Apple Mail writes it", () => {
    expectStripped(
      '<div>Danke</div><div class="replyHeader">On November 6, 2025, at 14:26, Anna &lt;<a href="mailto:a@b.de">a@b.de</a>&gt; wrote:<br></div><br><br><div><blockquote type="cite"><p>Alter Text</p></blockquote></div>',
      ["Danke"],
      ["wrote", "Alter Text"],
    );
  });

  it("accepts an attribution without a verb in front of a marked reply quote", () => {
    expectStripped(
      '<p>Danke</p><div class="hs_reply"><br><div>Mittwoch, 17. Dezember 2025, 21:20:50 +0100, Anna <span dir="ltr">&lt;<a href="mailto:a@b.de">a@b.de</a>&gt;</span>: <br><blockquote class="hs_reply_quote">Alter Text</blockquote></div></div>',
      ["Danke"],
      ["Mittwoch", "Alter Text"],
    );
    expectStripped(
      '<div>Ok</div><div name="messageReplySection">Nachricht von Anna &lt;a@b.de&gt; am 7. Nov. 2025, 11:15 +0100:<br><blockquote type="cite"><div>Alter Text</div></blockquote></div>',
      ["Ok"],
      ["Nachricht von", "Alter Text"],
    );
  });

  it("keeps an unmarked blockquote after a line that merely mentions a time", () => {
    expect(stripQuotedHtml("<p>Bitte bis 14:00 Uhr beachten:</p><blockquote>Wichtig</blockquote>")).toBeNull();
  });

  it("drops a blockquote marked as a reply quote even without an attribution", () => {
    expectStripped('<div>Danke</div><div><br></div><blockquote class="gmail_quote"><div>Alter Text</div></blockquote>', ["Danke"], ["Alter Text"]);
  });

  it("cuts at an Outlook header paragraph after a rule", () => {
    expectStripped(
      "<p>Danke</p><p><br></p><hr><p><strong>Von:</strong> Anna &lt;a@b.de&gt;<br><strong>Gesendet:</strong> Montag, 13. April 2026 12:00<br><strong>An:</strong> Bob<br><strong>Betreff:</strong> Angebot</p><p>Alter Text</p>",
      ["Danke"],
      ["Von:", "Alter Text", "<hr"],
    );
  });

  it("cuts at a header block in front of a blockquote", () => {
    expectStripped(
      '<p>Ok</p><div>From: "Ahmed" &lt;a@b.com&gt;<br>Date: Fri, 03 Apr 2026 13:35:16 +0200<br>To: x@y.de<br>Subject: Re: Rabatt</div><blockquote>Alter Text</blockquote>',
      ["Ok"],
      ["From:", "Alter Text"],
    );
  });

  it("cuts at a header that shares its block with the signature", () => {
    expectStripped(
      "<div>Danke!<br>Bob<br>www.example.de<br><br>Von: Anna &lt;a@b.de&gt;<br>Datum: Mo., 6. Juli 2026<br>An: Bob<br>Betreff: Termin<br><br>Alter Text</div>",
      ["Danke!", "www.example.de"],
      ["Von:", "Alter Text"],
    );
  });

  it("reads header fields that sit in blocks of their own", () => {
    expectStripped(
      '<div>Danke</div><div>Bob</div><div>Von: "Anna" &lt;a@b.de&gt;</div><div>Datum: Mo., 6. Juli 2026 11:59</div><div>Betreff: Termin</div><div>An: "Bob" &lt;b@c.de&gt;</div><div>Alter Text</div>',
      ["Danke", "Bob"],
      ["Von:", "Alter Text"],
    );
  });

  it("does not take a date range for a header", () => {
    expect(stripQuotedHtml("<p>Hallo</p><p>Von: 01.10.2026 Datum: 05.10.2026</p>")).toBeNull();
    expect(stripQuotedHtml("<p>Hallo</p><p>Von: Montag bis Freitag bin ich weg.</p>")).toBeNull();
  });

  it("keeps a plain blockquote without an attribution line", () => {
    expect(stripQuotedHtml("<p>Hier der Text:</p><blockquote>Wichtiger Inhalt</blockquote>")).toBeNull();
  });

  it("keeps a bottom-posted reply", () => {
    expect(
      stripQuotedHtml('<div class="moz-cite-prefix">Am 12.10.26 schrieb Anna:<br></div><blockquote type="cite">Frage?</blockquote><p>Meine Antwort</p>'),
    ).toBeNull();
    expect(
      stripQuotedHtml('<div class="moz-cite-prefix">Am 12.10.26 um 11:02 schrieb Anna:</div><blockquote type="cite">Frage?</blockquote><p>Antwort</p><div class="moz-signature">-- <br>Anna</div>'),
    ).toBeNull();
  });

  it("drops the quote but keeps a Thunderbird signature placed below it", () => {
    expectStripped(
      '<p>Hallo,</p><p>neue Frage?</p><p>LG,</p><div class="moz-cite-prefix">Am 13.10.2026 um 15:53 schrieb Anna Berger:<br></div><blockquote type="cite" cite="mid:x@y"><p>Alter Text</p></blockquote><div class="moz-signature">-- <br>Anna Berger<br>Vertrieb</div>',
      ["neue Frage?", "Vertrieb"],
      ["schrieb Anna", "Alter Text"],
    );
  });

  it("keeps a loose signature after the quote", () => {
    expectStripped('<p>Ok</p><blockquote type="cite">Alt</blockquote>-- <br>Anna', ["Ok", "Anna"], ["Alt"]);
  });

  it("keeps interleaved answers", () => {
    expect(
      stripQuotedHtml('<blockquote type="cite">Frage 1</blockquote><p>Antwort 1</p><blockquote type="cite">Frage 2</blockquote><p>Antwort 2</p>'),
    ).toBeNull();
  });

  it("collapses nothing when only the quote would remain", () => {
    expect(stripQuotedHtml('<div class="gmail_quote">Alter Text</div>')).toBeNull();
  });

  it("keeps a Gmail forward", () => {
    expect(
      stripQuotedHtml('<div dir="ltr">FYI</div><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>From: Anna</div>Inhalt</div>'),
    ).toBeNull();
  });

  it("keeps an Apple Mail forward", () => {
    expect(
      stripQuotedHtml('<div>Siehe unten<br><blockquote type="cite"><div>Anfang der weitergeleiteten Nachricht:</div><div>Inhalt</div></blockquote></div>'),
    ).toBeNull();
  });

  it("keeps a forward written by Prudii", () => {
    expect(
      stripQuotedHtml("<p>Zur Info</p><p>---------- Weitergeleitete Nachricht ----------</p><p><strong>Von:</strong> Anna</p><blockquote>Inhalt</blockquote>"),
    ).toBeNull();
  });

  it("returns null for a mail without quoted history", () => {
    expect(stripQuotedHtml("<p>Hallo</p>")).toBeNull();
  });

  it("keeps the document's style sheets", () => {
    expectStripped(
      '<html><head><style>.x{color:red}</style></head><body><p class="x">Hi</p><div class="gmail_quote">Alt</div></body></html>',
      [".x{color:red}", "Hi"],
      ["Alt"],
    );
  });

  it("cuts at the original-message block eM Client writes", () => {
    expectStripped(
      '<div>Danke</div><div><div>------ Originalnachricht ------</div><div>Von "Anna" &lt;a@b.de&gt;</div><div>Datum 06.08.2026 10:58:38</div></div><div><blockquote type="cite"><p>Alter Text</p></blockquote></div>',
      ["Danke"],
      ["Originalnachricht", "Alter Text"],
    );
  });

  it("cuts at an original-message separator", () => {
    expectStripped(
      "<p>Ok.</p><p>-----Ursprüngliche Nachricht-----</p><p>Von: Anna</p><p>Text</p>",
      ["Ok."],
      ["Ursprüngliche", "Von: Anna", "Text"],
    );
  });
});

describe("stripQuotedText", () => {
  it("cuts at an attribution line", () => {
    expect(stripQuotedText("Danke!\n\nAm 12.10.2026 um 11:02 schrieb Anna Berger <a@b.de>:\n> Hallo\n> Jonas")).toBe("Danke!");
  });

  it("cuts at an attribution wrapped onto two lines", () => {
    expect(
      stripQuotedText("Thanks\n\nOn Mon, Oct 12, 2026 at 11:02 AM Anna Berger <anna.berger@nordlicht-studio.de>\nwrote:\n\n> Hi"),
    ).toBe("Thanks");
  });

  it("cuts at an original-message separator", () => {
    expect(stripQuotedText("Passt.\n\n-----Original Message-----\nFrom: Anna\nSent: Monday\n\nHallo")).toBe("Passt.");
  });

  it("cuts at an Outlook header block", () => {
    expect(
      stripQuotedText("Passt.\n\n________________________________\nVon: Anna Berger\nGesendet: Montag, 12. Oktober 2026 11:02\nAn: Jonas\nBetreff: AW: Angebot\n\nHallo"),
    ).toBe("Passt.");
  });

  it("cuts a trailing block of quoted lines", () => {
    expect(stripQuotedText("Ok\n\n> Hallo\n> Jonas\n")).toBe("Ok");
  });

  it("keeps a bottom-posted reply", () => {
    expect(stripQuotedText("Am 12.10.2026 um 11:02 schrieb Anna:\n> Frage?\n\nAntwort.")).toBeNull();
  });

  it("drops the quote but keeps a signature placed below it", () => {
    expect(
      stripQuotedText("Hallo,\r\n\r\nneue Frage?\r\n\r\nLG,\r\n\r\nAm 13.10.2026 um 15:53 schrieb Anna Berger:\r\n>\r\n> Alter Text\r\n>\r\n-- \r\nAnna Berger\r\nVertrieb\r\n"),
    ).toBe("Hallo,\n\nneue Frage?\n\nLG,\n\n-- \nAnna Berger\nVertrieb");
  });

  it("leaves a signature above the quote where it is", () => {
    expect(stripQuotedText("Ok\n-- \nAnna\n\nAm 12.10.2026 um 11:02 schrieb Bob:\n> Alt")).toBe("Ok\n-- \nAnna");
  });

  it("takes a short attribution above a trailing quote block along", () => {
    expect(stripQuotedText("Gern.\n\nAnna schrieb:\n> Kommst du?")).toBe("Gern.");
  });

  it("keeps interleaved answers", () => {
    expect(stripQuotedText("> Frage 1\nAntwort 1\n> Frage 2\nAntwort 2")).toBeNull();
  });

  it("collapses nothing when only the quote would remain", () => {
    expect(stripQuotedText("> Hallo")).toBeNull();
  });

  it("keeps a forward", () => {
    expect(stripQuotedText("FYI\n\n---------- Forwarded message ---------\nFrom: Anna\nDate: Mon\n\nInhalt")).toBeNull();
    expect(stripQuotedText("Siehe unten\n\nAnfang der weitergeleiteten Nachricht:\n\n> Inhalt")).toBeNull();
  });

  it("does not take a sentence ending in a colon for an attribution", () => {
    expect(stripQuotedText("Am Montag schrieb ich dir:\nbitte melde dich.")).toBeNull();
    expect(stripQuotedText("Wie ich dir am 12.10. schrieb:\nbitte melde dich.")).toBeNull();
  });

  it("returns null for a mail without quoted history", () => {
    expect(stripQuotedText("Hallo Jonas")).toBeNull();
  });
});

describe("isForwardSubject", () => {
  it("recognises forward prefixes", () => {
    for (const s of ["Fwd: Angebot", "WG: Angebot", "Fw: x", "TR: x", "RV: x", "  fwd:x"]) expect(isForwardSubject(s)).toBe(true);
  });

  it("ignores replies, including replies to forwards", () => {
    for (const s of ["AW: WG: Angebot", "Re: Fwd: x", "Angebot", "Wg-Zimmer"]) expect(isForwardSubject(s)).toBe(false);
  });
});
