import { describe, it, expect } from "vitest";
import { bodyWithoutQuote, buildQuote, quoteFromHtml, renderQuote, splitQuote, stripQuoteMarker, type ComposeQuote } from "./composeQuote";
import { stripQuotedHtml } from "./quotedHistory";

const FORWARD: ComposeQuote = {
  kind: "forward",
  meta: {
    fromName: "Lena Hoffmann",
    fromEmail: "lena@studio-halde.de",
    date: "2026-10-14T09:12:00Z",
    subject: "Angebot Messestand Frühjahr 2027",
    to: "einkauf@beispiel.de",
  },
  body: "<p>Hallo zusammen,</p><table><tbody><tr><td>3</td><td>2.300 €</td></tr></tbody></table>",
};

const REPLY: ComposeQuote = {
  kind: "reply",
  meta: { fromName: "Lena Hoffmann", fromEmail: "lena@studio-halde.de", date: "2026-10-14T09:12:00Z" },
  body: "<p>Passt Donnerstag?</p>",
};

const REPLY_MARKER =
  "{&quot;kind&quot;:&quot;reply&quot;,&quot;fromName&quot;:&quot;Lena Hoffmann&quot;,&quot;fromEmail&quot;:&quot;lena@studio-halde.de&quot;,&quot;date&quot;:&quot;2026-10-14T09:12:00Z&quot;}";

function textOf(html: string): string {
  return new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
}

describe("splitQuote", () => {
  it("takes a reopened draft apart into the own text and the quote", () => {
    const draft = `<p>Hi Tom,</p><div data-prudii-quote="${REPLY_MARKER}"><p>Am 14.10.2026 schrieb Lena:</p><blockquote><p>Passt Donnerstag?</p></blockquote></div>`;
    const { rest, quote } = splitQuote(draft);
    expect(rest).toBe("<p>Hi Tom,</p>");
    expect(quote).toEqual(REPLY);
  });

  it("leaves a draft without a quote untouched", () => {
    const draft = "<p>Hi Tom,</p><blockquote><p>Passt Donnerstag?</p></blockquote>";
    expect(splitQuote(draft)).toEqual({ rest: draft, quote: null });
  });

  it("splits at the outer quote when the quoted mail carries one of its own", () => {
    const inner = `<div data-prudii-quote="${REPLY_MARKER}"><p>Lena schrieb:</p><blockquote><p>Passt Donnerstag?</p></blockquote></div>`;
    const outerMarker = REPLY_MARKER.replace("Lena Hoffmann", "Tom Berger").replace("lena@studio-halde.de", "tom@beispiel.de");
    const draft = `<p>Gut.</p><div data-prudii-quote="${outerMarker}"><p>Tom schrieb:</p><blockquote><p>Ja.</p>${inner}</blockquote></div>`;
    const { rest, quote } = splitQuote(draft);
    expect(rest).toBe("<p>Gut.</p>");
    expect(quote?.kind === "reply" && quote.meta.fromName).toBe("Tom Berger");
    expect(quote?.body).toBe(`<p>Ja.</p>${inner}`);
  });

  it("keeps a quote whose layout a mail server rewrote as it is", () => {
    const wrapper = `<div data-prudii-quote="${REPLY_MARKER}"><p>Lena schrieb:</p><div><p>Passt Donnerstag?</p></div></div>`;
    const { rest, quote } = splitQuote(`<p>Hi</p>${wrapper}`);
    expect(rest).toBe("<p>Hi</p>");
    expect(quote).toEqual({ kind: "raw", body: wrapper });
  });

  it("keeps a quote with an unreadable marker as it is", () => {
    const wrapper = `<div data-prudii-quote="{kaputt"><p>Lena schrieb:</p><blockquote><p>Passt Donnerstag?</p></blockquote></div>`;
    expect(splitQuote(wrapper).quote).toEqual({ kind: "raw", body: wrapper });
  });

  it("keeps a quote with content after its blockquote as it is", () => {
    const wrapper = `<div data-prudii-quote="${REPLY_MARKER}"><p>Lena schrieb:</p><blockquote><p>Passt Donnerstag?</p></blockquote><p>Rest</p></div>`;
    expect(splitQuote(wrapper).quote).toEqual({ kind: "raw", body: wrapper });
  });

  it("leaves a marker alone that sits inside a quote another client wrote", () => {
    const draft = `<p>Klar.</p><blockquote type="cite"><p>Tom schrieb:</p><div data-prudii-quote="${REPLY_MARKER}"><p>Lena schrieb:</p><blockquote><p>Passt Donnerstag?</p></blockquote></div></blockquote>`;
    expect(splitQuote(draft)).toEqual({ rest: draft, quote: null });
  });
});

describe("buildQuote", () => {
  const MAIL = {
    from: { name: "Lena Hoffmann", email: "lena@studio-halde.de" },
    to: [{ name: "", email: "einkauf@beispiel.de" }, { name: "Tom Berger", email: "tom@beispiel.de" }],
    date: "2026-10-14T09:12:00Z",
    subject: "Angebot Messestand Frühjahr 2027",
  };

  it("takes sender, date, subject and recipients for a forward", () => {
    expect(buildQuote("forward", MAIL, "<p>Hallo</p>")).toEqual({
      kind: "forward",
      meta: {
        fromName: "Lena Hoffmann",
        fromEmail: "lena@studio-halde.de",
        date: "2026-10-14T09:12:00Z",
        subject: "Angebot Messestand Frühjahr 2027",
        to: "einkauf@beispiel.de, Tom Berger <tom@beispiel.de>",
      },
      body: "<p>Hallo</p>",
    });
  });

  it("takes only sender and date for a reply", () => {
    expect(buildQuote("reply", MAIL, "<p>Hallo</p>").meta).toEqual({
      fromName: "Lena Hoffmann",
      fromEmail: "lena@studio-halde.de",
      date: "2026-10-14T09:12:00Z",
    });
  });

  it("survives a draft round trip when the quoted mail has stray end tags", () => {
    const quote = buildQuote("reply", MAIL, "<p>Angebot</p></div><p>Mitte</p></blockquote><p>Ende</p>");
    expect(splitQuote(`<p>Hi</p>${renderQuote(quote)}`)).toEqual({ rest: "<p>Hi</p>", quote });
    expect(textOf(quote.body)).toBe("AngebotMitteEnde");
  });
});

describe("stripQuoteMarker", () => {
  it("sends the quote without the marker that would give the client away", () => {
    const body = `<p>Hi</p>${renderQuote(FORWARD)}`;
    const sent = stripQuoteMarker(body);
    expect(sent).not.toContain("data-prudii-quote");
    expect(textOf(sent)).toBe(textOf(body));
  });
});

describe("bodyWithoutQuote", () => {
  it("cuts an unmarked quote off a body saved before quotes were marked", () => {
    const quoted = "<p>On Tue, Lena wrote:</p><blockquote><p>Passt Donnerstag?</p></blockquote>";
    expect(bodyWithoutQuote(`<p>Hi</p>${quoted}`, quoted)).toBe("<p>Hi</p>");
  });

  it("cuts a marked quote off a saved body", () => {
    const quoted = renderQuote(REPLY);
    expect(bodyWithoutQuote(`<p>Hi</p>${quoted}`, quoted)).toBe("<p>Hi</p>");
    expect(bodyWithoutQuote(`<p>Hi</p>${quoted}`, undefined)).toBe("<p>Hi</p>");
  });

  it("leaves a body without a quote alone", () => {
    expect(bodyWithoutQuote("<p>Hi</p>", undefined)).toBe("<p>Hi</p>");
  });
});

describe("renderQuote", () => {
  it("comes back intact from the HTML it writes", () => {
    for (const quote of [FORWARD, REPLY]) {
      expect(splitQuote(`<p>Hi</p>${renderQuote(quote)}`)).toEqual({ rest: "<p>Hi</p>", quote });
    }
  });

  it("shows recipients the classic forward header", () => {
    const text = textOf(renderQuote(FORWARD));
    expect(text).toContain("Forwarded message");
    expect(text).toContain("Lena Hoffmann <lena@studio-halde.de>");
    expect(text).toContain("Angebot Messestand Frühjahr 2027");
    expect(text).toContain("einkauf@beispiel.de");
  });

  it("escapes the sender's name", () => {
    const quote: ComposeQuote = { ...REPLY, meta: { ...REPLY.meta, fromName: '<img src=x onerror="alert(1)">' } };
    const html = renderQuote(quote);
    expect(new DOMParser().parseFromString(html, "text/html").querySelector("img")).toBeNull();
    expect(splitQuote(html).quote).toEqual(quote);
  });

  it("sends a raw quote exactly as it was", () => {
    const body = "<p>On Tue, Lena wrote:</p><blockquote><p>Passt Donnerstag?</p></blockquote>";
    expect(renderQuote({ kind: "raw", body })).toBe(body);
  });

  it("lets a sent reply's quote collapse in the thread view", () => {
    const stripped = stripQuotedHtml(`<p>Donnerstag passt.</p>${renderQuote(REPLY)}`);
    expect(stripped).toContain("Donnerstag passt.");
    expect(stripped).not.toContain("Passt Donnerstag?");
  });
});

describe("quoteFromHtml", () => {
  it("brings back a quote saved before quotes were marked, unchanged", () => {
    const old = "<p>On Tue, Lena wrote:</p><blockquote><p>Passt Donnerstag?</p></blockquote>";
    expect(quoteFromHtml(old)).toEqual({ kind: "raw", body: old });
  });

  it("brings back a marked quote with its sender", () => {
    expect(quoteFromHtml(renderQuote(FORWARD))).toEqual(FORWARD);
  });

  it("has no quote for an empty snapshot", () => {
    expect(quoteFromHtml(undefined)).toBeNull();
    expect(quoteFromHtml("")).toBeNull();
  });
});
