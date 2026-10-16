import { describe, it, expect, afterEach } from "vitest";
import { Editor, Node } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import TiptapImage from "@tiptap/extension-image";
import { mentionsAttachment, needsAttachmentReminder } from "./attachmentReminder";
import en from "../../locales/en.json";
import de from "../../locales/de.json";
import es from "../../locales/es.json";
import fr from "../../locales/fr.json";
import pt from "../../locales/pt.json";
import ru from "../../locales/ru.json";
import zh from "../../locales/zh.json";

const SignatureNode = Node.create({
  name: "signature",
  group: "block",
  content: "block*",
  parseHTML() { return [{ tag: 'div[data-type="signature"]' }]; },
  renderHTML() { return ["div", { "data-type": "signature" }, 0]; },
});

let editor: Editor;

afterEach(() => editor?.destroy());

function make(html: string) {
  editor = new Editor({
    extensions: [
      StarterKit.configure({ heading: false, link: false, underline: false }),
      Link.configure({ openOnClick: false }),
      TiptapImage.configure({ inline: true, allowBase64: true }),
      SignatureNode,
    ],
    content: html,
  });
  return editor;
}

describe("mentionsAttachment", () => {
  it.each([
    "Im Anhang findest du die Rechnung.",
    "Anbei die Unterlagen.",
    "Ich habe dir die Datei angehängt.",
    "Beigefügt das Angebot.",
    "Die Preisliste sende ich in der Anlage.",
    "Please find attached the report.",
    "See the attachment for details.",
    "I have enclosed the invoice.",
    "Te envío el archivo adjunto.",
    "Segue em anexo o contrato.",
    "Vous trouverez ci-joint le devis.",
    "Le contrat est en pièce jointe.",
    "Документ во вложении.",
    "Прилагаю договор.",
    "请查收附件。",
    "附上报价单。",
  ])("finds the mention in %s", (text) => {
    expect(mentionsAttachment(text)).toBe(true);
  });

  it.each([
    "Bis morgen, danke!",
    "Die Anlage läuft wieder.",
    "Der Anhänger ist kaputt.",
    "Скачайте наше приложение.",
    "Thanks for the update.",
  ])("stays quiet for %s", (text) => {
    expect(mentionsAttachment(text)).toBe(false);
  });
});

describe("needsAttachmentReminder", () => {
  it("asks when the text mentions a file but none is attached", () => {
    expect(needsAttachmentReminder(make("<p>Anbei die Datei.</p>"), 0)).toBe(true);
  });

  it("stays quiet once a file is attached", () => {
    expect(needsAttachmentReminder(make("<p>Anbei die Datei.</p>"), 1)).toBe(false);
  });

  it("ignores the quoted original mail", () => {
    expect(needsAttachmentReminder(make("<p>Danke!</p><blockquote><p>Anbei die Datei.</p></blockquote>"), 0)).toBe(false);
  });

  it("ignores the signature's disclaimer", () => {
    const html = '<p>Danke!</p><div data-type="signature"><p>This email and any attachments are confidential.</p></div>';
    expect(needsAttachmentReminder(make(html), 0)).toBe(false);
  });

  it("counts an image pasted into the text as attached", () => {
    const html = '<p>Anbei der Screenshot: <img src="data:image/png;base64,iVBORw0KGgo="></p>';
    expect(needsAttachmentReminder(make(html), 0)).toBe(false);
  });
});

describe("attachment reminder texts", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    it(`${lang} explains the reminder`, () => {
      const compose = (data as { compose: Record<string, unknown> }).compose;
      const keys = ["attachmentReminderTitle", "attachmentReminderMessage", "sendWithoutAttachment"];
      expect(keys.filter((k) => typeof compose[k] !== "string" || !(compose[k] as string).trim())).toEqual([]);
    });
  }
});
