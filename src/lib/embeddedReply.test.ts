import { describe, it, expect, vi } from "vitest";
import { splitEmbeddedMails, type EmbeddedMail } from "./embeddedMails";
import { cardBadge, embeddedMailToMail, initiallyOpen, resolveNameOnlySender } from "./embeddedReply";
import { visibleText } from "./quotedHistory";
import type { Contact, Mail } from "../types";

const JONAS = { name: "Jonas Berger", email: "jonas.berger@studio-halde.example" };

const CHAIN =
  '<div>Fürs Protokoll.</div><div style="border:none;border-top:solid #E1E1E1 1.0pt"><p><b>Von:</b> Lea Kraus &lt;kontakt@studio-halde.example&gt;<br><b>Gesendet:</b> Freitag, 12. September 2026 22:22<br><b>An:</b> planung@studio-halde.example<br><b>Betreff:</b> WG: Terminverschiebung</p></div><p>Bitte einplanen.</p>' +
  '<div class="gmail_quote"><div class="gmail_attr">---------- Forwarded message ---------<br>Von: <strong>Helga Brandt</strong> <span>&lt;helga.brandt@posteo.example&gt;</span><br>Date: Fr., 12. Sept. 2026 um 21:10 Uhr<br>Subject: Terminverschiebung<br>To: &lt;kontakt@studio-halde.example&gt;<br></div><br><br><div>Guten Abend, der Termin rutscht.</div></div>';

const outerMail = (over: Partial<Mail> = {}): Mail => ({
  id: "mail-1",
  account_id: "acc-1",
  folder_id: "folder-1",
  message_id: "<a@studio-halde.example>",
  uid: 7,
  subject: "WG: Terminverschiebung",
  from: JONAS,
  to: [{ name: "Anna Weber", email: "anna.weber@studio-halde.example" }],
  cc: [],
  bcc: [],
  date: "2026-09-13T08:00:00Z",
  snippet: "Fürs Protokoll.",
  body_text: "Fürs Protokoll.",
  body_html: CHAIN,
  is_read: true,
  is_starred: true,
  is_flagged: true,
  is_replied: true,
  is_forwarded: true,
  has_attachments: true,
  thread_id: "thread-1",
  in_reply_to: "<b@studio-halde.example>",
  references: "<b@studio-halde.example> <a@studio-halde.example>",
  size_bytes: 1200,
  flags: ["red"],
  list_unsubscribe: null,
  reply_to: [JONAS],
  is_pinned: true,
  snoozed_until: "2026-10-01T00:00:00Z",
  ...over,
});

const visible = (html: string) => visibleText(new DOMParser().parseFromString(html, "text/html").body);

const part = (over: Partial<EmbeddedMail> = {}): EmbeddedMail => ({
  from: { name: "", email: "" },
  to: [],
  cc: [],
  date: "",
  subject: "",
  header: "",
  html: "",
  quote: () => "",
  preview: "",
  ...over,
});

describe("embeddedMailToMail", () => {
  const parts = splitEmbeddedMails(CHAIN)!.parts;

  it("reply target carries nothing from the mails above", () => {
    const target = embeddedMailToMail(outerMail(), parts[1]);
    expect(target.reply_to).toEqual([]);
    expect(target.message_id).toBe("");
    expect(target.in_reply_to).toBeNull();
    expect(target.references).toBe("");
    expect(target.from.name).toBe("Helga Brandt");
    expect(visible(target.body_html)).toContain("Guten Abend");
    for (const word of ["Protokoll", "Lea", "einplanen"]) expect(visible(target.body_html)).not.toContain(word);
  });

  it("is a plain object", () => {
    const target = embeddedMailToMail(outerMail(), parts[0]);
    expect(JSON.parse(JSON.stringify(target))).toEqual(target);
  });

  it("keeps the outer mail's id and attachments for forwarding", () => {
    const target = embeddedMailToMail(outerMail(), parts[1]);
    expect(target.id).toBe("mail-1");
    expect(target.account_id).toBe("acc-1");
    expect(target.has_attachments).toBe(true);
  });

  it("falls back to the outer subject without prefixes", () => {
    const target = embeddedMailToMail(outerMail({ subject: "AW: WG: Terminverschiebung" }), part());
    expect(target.subject).toBe("Terminverschiebung");
  });
});

describe("resolveNameOnlySender", () => {
  const contact = (name: string, email: string): Contact => ({ name, email, frequency: 1 });
  const nameOnly = () => outerMail({ from: { name: "Helga Brandt", email: "" } });

  it("finds a name-only sender in the contacts", async () => {
    const search = vi.fn().mockResolvedValue([contact(" helga brandt ", "helga.brandt@posteo.example")]);
    const result = await resolveNameOnlySender(nameOnly(), search);
    expect(search).toHaveBeenCalledWith("Helga Brandt");
    expect(result.from.email).toBe("helga.brandt@posteo.example");
  });

  it("leaves the mail alone when two contacts match exactly", async () => {
    const mail = nameOnly();
    const search = vi.fn().mockResolvedValue([contact("Helga Brandt", "a@posteo.example"), contact("Helga Brandt", "b@posteo.example")]);
    expect(await resolveNameOnlySender(mail, search)).toBe(mail);
  });

  it("leaves the mail alone on a substring match", async () => {
    const mail = outerMail({ from: { name: "Lea", email: "" } });
    const search = vi.fn().mockResolvedValue([contact("Lea Krause", "lea@posteo.example")]);
    expect(await resolveNameOnlySender(mail, search)).toBe(mail);
  });

  it("does not search when the sender has an address", async () => {
    const search = vi.fn();
    const mail = outerMail();
    expect(await resolveNameOnlySender(mail, search)).toBe(mail);
    expect(search).not.toHaveBeenCalled();
  });
});

describe("cardBadge", () => {
  it("marks the original and forwarded cards", () => {
    const parts = [part({ subject: "WG: X" }), part({ subject: "X" }), part({ subject: "X" })];
    expect(parts.map((_, i) => cardBadge(parts, i))).toEqual(["forwarded", null, "original"]);
  });
});

describe("initiallyOpen", () => {
  it("opens all cards up to two, else only the original", () => {
    expect(initiallyOpen(1)).toEqual([true]);
    expect(initiallyOpen(2)).toEqual([true, true]);
    expect(initiallyOpen(5)).toEqual([false, false, false, false, true]);
  });
});
