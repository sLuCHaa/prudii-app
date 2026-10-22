import { describe, it, expect } from "vitest";
import { splitEmbeddedMails } from "./embeddedMails";
import { buildQuote, renderQuote } from "./composeQuote";
import { visibleText } from "./quotedHistory";
import type { Mail } from "../types";

const strip = (s: string) => s.replace(/[\s​-‍﻿]/g, "");
const textOf = (html: string) => strip(visibleText(new DOMParser().parseFromString(html, "text/html").body));
const topLevel = (html: string) => Array.from(new DOMParser().parseFromString(html, "text/html").body.children).filter((e) => e.tagName !== "STYLE");

const LEA = { name: "Lea Kraus", email: "kontakt@studio-halde.example" };
const HELGA = { name: "Helga Brandt", email: "helga.brandt@posteo.example" };
const PLANUNG = { name: "", email: "planung@studio-halde.example" };

interface Fixture {
  name: string;
  html: string;
  outer: string;
  body: string;
  from: { name: string; email: string };
  subject: string;
  to: { name: string; email: string }[];
}

const forwardMail = {
  from: HELGA,
  to: [LEA],
  date: "2026-09-12T21:10:00",
  subject: "Terminverschiebung",
} as Pick<Mail, "from" | "to" | "date" | "subject">;

const FIXTURES: Fixture[] = [
  {
    name: "Outlook desktop",
    html:
      '<p class="MsoNormal">Bitte weiterleiten.</p><div style="border:none;border-top:solid #E1E1E1 1.0pt"><p class="MsoNormal"><b>Von:</b> Lea Kraus &lt;kontakt@studio-halde.example&gt;<br><b>Gesendet:</b> Freitag, 12. September 2026 22:22<br><b>An:</b> planung@studio-halde.example<br><b>Betreff:</b> WG: Terminverschiebung</p></div><p class="MsoNormal">Bitte einplanen.</p>',
    outer: "Bitte weiterleiten.",
    body: "Bitte einplanen.",
    from: LEA,
    subject: "WG: Terminverschiebung",
    to: [PLANUNG],
  },
  {
    name: "OWA",
    html:
      '<div>Kurz zur Info.</div><div id="appendonsend"></div><hr style="display:inline-block;width:98%"><div id="divRplyFwdMsg"><font><b>From:</b> Lea Kraus &lt;kontakt@studio-halde.example&gt;<br><b>Sent:</b> Friday, September 12, 2026 10:22 PM<br><b>To:</b> planung@studio-halde.example<br><b>Subject:</b> Schedule change</font></div><div>Please plan accordingly.</div>',
    outer: "Kurz zur Info.",
    body: "Please plan accordingly.",
    from: LEA,
    subject: "Schedule change",
    to: [PLANUNG],
  },
  {
    name: "Gmail",
    html:
      '<div dir="ltr">Zur Kenntnis.</div><br><div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>Von: <strong class="gmail_sendername">Helga Brandt</strong> <span>&lt;helga.brandt@posteo.example&gt;</span><br>Date: Fr., 12. Sept. 2026 um 21:10 Uhr<br>Subject: Terminverschiebung<br>To: &lt;kontakt@studio-halde.example&gt;<br></div><br><br><div>Guten Abend, der Termin rutscht.</div></div>',
    outer: "Zur Kenntnis.",
    body: "Guten Abend, der Termin rutscht.",
    from: HELGA,
    subject: "Terminverschiebung",
    to: [{ name: "", email: "kontakt@studio-halde.example" }],
  },
  {
    name: "Apple Mail",
    html:
      '<div>Schau mal.</div><div><br></div><div>Anfang der weitergeleiteten Nachricht:</div><br><blockquote type="cite"><div><b>Von: </b><span>Helga Brandt &lt;helga.brandt@posteo.example&gt;</span></div><div><b>Betreff: </b><span>Terminverschiebung</span></div><div><b>Datum: </b><span>12. September 2026 um 21:10:13 MESZ</span></div><div><b>An: </b><span>Lea Kraus &lt;kontakt@studio-halde.example&gt;</span></div><br><div>Guten Abend, der Termin rutscht.</div></blockquote>',
    outer: "Schau mal.",
    body: "Guten Abend, der Termin rutscht.",
    from: HELGA,
    subject: "Terminverschiebung",
    to: [LEA],
  },
  {
    name: "Thunderbird",
    html:
      '<p>Siehe unten.</p><div class="moz-forward-container">-------- Weitergeleitete Nachricht --------<table class="moz-email-headers-table"><tr><th>Betreff:</th><td>Terminverschiebung</td></tr><tr><th>Datum:</th><td>Fri, 12 Sep 2026 21:10:00 +0200</td></tr><tr><th>Von:</th><td>Helga Brandt &lt;helga.brandt@posteo.example&gt;</td></tr><tr><th>An:</th><td>Lea Kraus &lt;kontakt@studio-halde.example&gt;</td></tr></table><br>Guten Abend, der Termin rutscht.</div>',
    outer: "Siehe unten.",
    body: "Guten Abend, der Termin rutscht.",
    from: HELGA,
    subject: "Terminverschiebung",
    to: [LEA],
  },
  {
    name: "Prudii forward",
    html: `<p>Hier die Mail.</p>${renderQuote(buildQuote("forward", forwardMail, "<p>Guten Abend, der Termin rutscht.</p>"))}`,
    outer: "Hier die Mail.",
    body: "Guten Abend, der Termin rutscht.",
    from: { name: "Helga Brandt", email: "helga.brandt@posteo.example" },
    subject: "Terminverschiebung",
    to: [{ name: "Lea Kraus", email: "kontakt@studio-halde.example" }],
  },
  {
    name: "Ursprüngliche Nachricht",
    html:
      "<div>Anbei die Unterlagen.</div><div>-----Ursprüngliche Nachricht-----<br>Von: Helga Brandt &lt;helga.brandt@posteo.example&gt;<br>Gesendet: Freitag, 12. September 2026 21:10<br>An: Lea Kraus &lt;kontakt@studio-halde.example&gt;<br>Betreff: Unterlagen<br><br>Hier sind die Unterlagen.</div>",
    outer: "Anbei die Unterlagen.",
    body: "Hier sind die Unterlagen.",
    from: HELGA,
    subject: "Unterlagen",
    to: [LEA],
  },
];

describe("splitEmbeddedMails", () => {
  it.each(FIXTURES)("finds the embedded mail in $name", (f) => {
    const split = splitEmbeddedMails(f.html);
    expect(split).not.toBeNull();
    expect(split!.parts).toHaveLength(1);
    const part = split!.parts[0];
    expect(part.from).toEqual(f.from);
    expect(part.subject).toBe(f.subject);
    expect(part.to).toEqual(f.to);
    expect(textOf(part.html)).toBe(strip(f.body));
    expect(textOf(split!.outer)).toBe(strip(f.outer));
    expect(part.preview).toBe(f.body);
  });

  it.each(FIXTURES)("keeps every visible character exactly once in $name", (f) => {
    const split = splitEmbeddedMails(f.html)!;
    const rebuilt = textOf(split.outer) + split.parts.map((p) => strip(p.header) + textOf(p.html)).join("");
    expect(rebuilt).toBe(textOf(f.html));
  });

  it("parses the dates of the formats", () => {
    const dates = FIXTURES.slice(0, 5).map((f) => splitEmbeddedMails(f.html)!.parts[0].date);
    expect(new Date(dates[0]).getHours()).toBe(22);
    expect(new Date(dates[1]).getHours()).toBe(22);
    expect(new Date(dates[2]).getHours()).toBe(21);
    expect(new Date(dates[3]).getSeconds()).toBe(13);
    expect(new Date(dates[4]).getTime()).toBe(Date.parse("2026-09-12T21:10:00+02:00"));
  });

  it("orders a chain newest first", () => {
    const html =
      '<div>Fürs Protokoll.</div><div style="border:none;border-top:solid #E1E1E1 1.0pt"><p><b>Von:</b> Lea Kraus &lt;kontakt@studio-halde.example&gt;<br><b>Gesendet:</b> Freitag, 12. September 2026 22:22<br><b>An:</b> planung@studio-halde.example<br><b>Betreff:</b> WG: Terminverschiebung</p></div><p>Bitte einplanen.</p>' +
      FIXTURES[2].html;
    const split = splitEmbeddedMails(html)!;
    expect(split.parts.map((p) => p.from.name)).toEqual(["Lea Kraus", "Helga Brandt"]);
    expect(textOf(split.parts[0].quote())).toContain(strip("Bitte einplanen."));
    expect(textOf(split.parts[0].quote())).toContain(strip("Guten Abend, der Termin rutscht."));
    expect(textOf(split.parts[1].quote())).toContain(strip("Guten Abend, der Termin rutscht."));
    expect(textOf(split.parts[1].quote())).not.toContain(strip("Bitte einplanen."));
    expect(textOf(split.parts[0].html)).toBe(strip("Bitte einplanen.Zur Kenntnis."));
  });

  it("splits a forty-level chain", () => {
    let html = "<p>Ganz unten.</p>";
    for (let i = 40; i >= 1; i--) {
      html = `<p>Antwort ${i}</p><div style="border-top:solid #E1E1E1 1pt"><p><b>Von:</b> Absender ${i} &lt;a${i}@studio-halde.example&gt;<br><b>Gesendet:</b> Freitag, 12. September 2026 22:22<br><b>An:</b> b@studio-halde.example<br><b>Betreff:</b> Thema ${i}</p></div><div>${html}</div>`;
    }
    const start = performance.now();
    const split = splitEmbeddedMails(`<p>Neu.</p>${html}`)!;
    expect(performance.now() - start).toBeLessThan(500);
    expect(split.parts).toHaveLength(40);
    expect(split.parts.map((p) => p.subject)).toEqual(Array.from({ length: 40 }, (_, i) => `Thema ${i + 1}`));
  });

  it("keeps a level in an unknown format inside the card above", () => {
    const html =
      '<p>Neu.</p><div>-----Ursprüngliche Nachricht-----<br>Von: Helga Brandt &lt;helga.brandt@posteo.example&gt;<br>Gesendet: Freitag, 12. September 2026 21:10<br>Betreff: Unterlagen<br><br>Hier sind die Unterlagen.</div><p>Am 12.09.2026 schrieb Tom Weiß:</p><blockquote>Davor stand das.</blockquote>';
    const split = splitEmbeddedMails(html)!;
    expect(split.parts).toHaveLength(1);
    expect(textOf(split.parts[0].html)).toContain(strip("Davor stand das."));
  });

  it("leaves a signature with a Von line uncut", () => {
    expect(splitEmbeddedMails("<p>Danke!</p><p>Von: Anna Weber<br>Studio Halde</p>")).toBeNull();
  });

  it("recognises labels in bold, with nbsp and in table cells", () => {
    const variants = [
      "<p><b>Von:</b>&nbsp;Lea Kraus &lt;kontakt@studio-halde.example&gt;</p><p><b>Gesendet:</b>&nbsp;Freitag, 12. September 2026 22:22</p><p><b>An:</b>&nbsp;planung@studio-halde.example</p><p>Text</p>",
      "<p>Von&nbsp;: Lea Kraus &lt;kontakt@studio-halde.example&gt;<br>Date&nbsp;: Fri, 12 Sep 2026 22:22:00 +0200<br>À&nbsp;: planung@studio-halde.example</p><p>Text</p>",
      "<table><tr><td><b>Von:</b></td><td>Lea Kraus &lt;kontakt@studio-halde.example&gt;</td></tr><tr><td><b>Gesendet:</b></td><td>Freitag, 12. September 2026 22:22</td></tr><tr><td><b>An:</b></td><td>planung@studio-halde.example</td></tr></table><p>Text</p>",
      "<p><span><b>Von</b></span><span>: Lea Kraus &lt;kontakt@studio-halde.example&gt;</span></p><p><b>Gesendet</b>:<span> Freitag, 12. September 2026 22:22</span></p><p><b>An</b>: planung@studio-halde.example</p><p>Text</p>",
    ];
    for (const v of variants) {
      const split = splitEmbeddedMails(`<p>Oben.</p>${v}`);
      expect(split?.parts, v).toHaveLength(1);
      expect(split!.parts[0].from.email).toBe(LEA.email);
      expect(textOf(split!.parts[0].html)).toBe("Text");
    }
  });

  it("carries the mail's styles into every part", () => {
    const html = `<html><head><style>.x{color:red}</style></head><body>${FIXTURES[2].html}</body></html>`;
    const split = splitEmbeddedMails(html)!;
    for (const out of [split.outer, split.parts[0].html, split.parts[0].quote()]) {
      expect(out).toContain("<style>.x{color:red}</style>");
    }
  });

  it("does not duplicate a style that sits in the body", () => {
    const split = splitEmbeddedMails(`<style>.x{color:red}</style>${FIXTURES[2].html}`)!;
    expect(split.parts[0].html.match(/<style/g)).toHaveLength(1);
  });

  it("unwraps the quote wrapper around a card body", () => {
    for (const f of [FIXTURES[3], FIXTURES[2]]) {
      const [only] = topLevel(splitEmbeddedMails(f.html)!.parts[0].html);
      expect(only.matches("blockquote, .gmail_quote")).toBe(false);
    }
  });

  it("has no outer part when the mail starts with the header", () => {
    const html = FIXTURES[2].html.replace('<div dir="ltr">Zur Kenntnis.</div><br>', "");
    expect(splitEmbeddedMails(html)!.outer).toBe("");
  });

  it("keeps the address of a Nachname, Vorname sender", () => {
    const html =
      "<p>Oben.</p><p><b>Von:</b> Kraus, Lea &lt;lea.kraus@studio-halde.example&gt;<br><b>Gesendet:</b> Freitag, 12. September 2026 22:22<br><b>An:</b> Berger, Jonas &lt;jonas.berger@studio-halde.example&gt;; Weber, Anna &lt;anna.weber@studio-halde.example&gt;<br><b>Betreff:</b> Termin</p><p>Text</p>";
    const part = splitEmbeddedMails(html)!.parts[0];
    expect(part.from).toEqual({ name: "Kraus, Lea", email: "lea.kraus@studio-halde.example" });
    expect(part.to.map((a) => a.email)).toEqual(["jonas.berger@studio-halde.example", "anna.weber@studio-halde.example"]);
  });

  it("returns null for a mail without headers", () => {
    expect(splitEmbeddedMails("<p>Hallo Lea,</p><p>bis morgen.</p>")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(splitEmbeddedMails("")).toBeNull();
  });
});
