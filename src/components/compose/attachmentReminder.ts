import type { Editor } from "@tiptap/core";

const LETTER = String.raw`[\p{L}\p{N}]`;

// Bare "Anlage" and "приложение" also mean plant and app, so only their attachment phrasings count.
const WORDS = [
  "anhang", "anhänge", "anhängen", "anbei", String.raw`angehängt\p{L}*`, String.raw`beigefügt\p{L}*`, String.raw`beiliegend\p{L}*`,
  "in der anlage", "als anlage",
  String.raw`attach\p{L}*`, "enclosed",
  String.raw`adjunt\p{L}*`, String.raw`anex\p{L}*`,
  String.raw`pièces? jointes?`, String.raw`ci-joint\p{L}*`, "je joins",
  String.raw`вложени\p{L}*`, String.raw`прикрепл\p{L}*`, String.raw`прилага\p{L}*`,
];

const ATTACHMENT_WORDS = new RegExp(`(?<!${LETTER})(?:${WORDS.join("|")})(?!${LETTER})|附件|附檔|附上|随附|隨附`, "iu");

const NOT_OWN_TEXT = new Set(["blockquote", "signature"]);

export function mentionsAttachment(text: string): boolean {
  return ATTACHMENT_WORDS.test(text);
}

export function needsAttachmentReminder(editor: Editor, attachmentCount: number): boolean {
  if (attachmentCount > 0) return false;
  let text = "";
  let hasImage = false;
  editor.state.doc.descendants((node) => {
    if (NOT_OWN_TEXT.has(node.type.name)) return false;
    if (node.type.name === "image") hasImage = true;
    if (node.isTextblock) text += `${node.textContent}\n`;
    return true;
  });
  return !hasImage && mentionsAttachment(text);
}
