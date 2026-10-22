import type { MailAddress } from "../types";
import { FORWARD_LABELS, ORIGINAL_SEPARATOR } from "./quotedHistory";

export type HeaderField = "from" | "date" | "to" | "cc" | "subject";

const LABELS: Record<HeaderField, string> = {
  from: "from|von|de|da|от|发件人|van|od|fra",
  date: "sent|gesendet|date|datum|envoyé|enviado|enviada|inviato|отправлено|发送时间|verzonden|wysłano|skickat|sendt",
  to: "to|an|à|para|a|кому|收件人",
  cc: "cc|kopie",
  subject: "subject|betreff|objet|asunto|assunto|oggetto|тема|主题|onderwerp|temat|ämne|emne",
};

const FIELDS = Object.keys(LABELS) as HeaderField[];
const LABEL_PATTERN = new RegExp(`^\\s*(${FIELDS.map((f) => `(?<${f}>${LABELS[f]})`).join("|")})\\s*[:：]\\s*(?<value>.*)$`, "i");

export function headerLabel(line: string): { field: HeaderField; value: string } | null {
  const groups = LABEL_PATTERN.exec(line)?.groups;
  if (!groups) return null;
  const field = FIELDS.find((f) => groups[f] !== undefined);
  return field ? { field, value: groups.value.trim() } : null;
}

function splitList(text: string, separators: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  let depth = 0;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "<" || ch === "[")) depth++;
    else if (!quoted && (ch === ">" || ch === "]")) depth = Math.max(0, depth - 1);
    if (!quoted && depth === 0 && separators.includes(ch)) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

const EMAIL = /[^\s<>\[\]"',;:()]+@[^\s<>\[\]"',;:()]+/;

function parseAddress(raw: string): MailAddress | null {
  const text = raw.trim();
  if (!text) return null;
  const email = EMAIL.exec(text)?.[0] ?? "";
  const name = text
    .replace(/<[^>]*>|\[mailto:[^\]]*\]/gi, " ")
    .replace(email, " ")
    .replace(/["“”]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return { name, email };
}

const hasAddress = (piece: string) => EMAIL.test(piece);

function splitMailboxes(text: string): string[] {
  const groups = splitList(text, ";");
  return groups.flatMap((group) => {
    const pieces = splitList(group, ",");
    if (!pieces.some(hasAddress)) return groups.length > 1 ? [group] : pieces;
    const merged: string[] = [];
    let pending: string[] = [];
    for (const piece of pieces) {
      pending.push(piece);
      if (hasAddress(piece)) {
        merged.push(pending.join(","));
        pending = [];
      }
    }
    return [...merged, ...pending];
  });
}

export function parseAddressList(text: string): MailAddress[] {
  return splitMailboxes(text).map(parseAddress).filter((a): a is MailAddress => !!a);
}

export function parseMailbox(text: string): MailAddress | null {
  const emails = text.match(new RegExp(EMAIL.source, "g")) ?? [];
  return emails.length > 1 ? parseAddressList(text)[0] ?? null : parseAddress(text);
}

const MONTHS: Record<string, number> = {
  januar: 1, jan: 1, jänner: 1, january: 1,
  februar: 2, feb: 2, february: 2,
  märz: 3, mär: 3, maerz: 3, mrz: 3, march: 3, mar: 3,
  april: 4, apr: 4,
  mai: 5, may: 5,
  juni: 6, jun: 6, june: 6,
  juli: 7, jul: 7, july: 7,
  august: 8, aug: 8,
  september: 9, sep: 9, sept: 9,
  oktober: 10, okt: 10, october: 10, oct: 10,
  november: 11, nov: 11,
  dezember: 12, dez: 12, december: 12, dec: 12,
};

const pad = (n: number) => String(n).padStart(2, "0");
const month = (name: string) => MONTHS[name.toLowerCase().replace(/\./g, "")];
const NUMERIC_ZONE = /\s[+-]\d{2}:?\d{2}\s*$/;
const TIME = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]\.?m\.?)?/i;

function dateParts(text: string): [number, number, number] | null {
  let m = /(\d{1,2})\.(\d{1,2})\.(\d{4})/.exec(text);
  if (m) return [+m[3], +m[2], +m[1]];
  m = /(\d{1,2})\.?\s*([a-zäöü]+)\.?\s*,?\s*(\d{4})/i.exec(text);
  if (m && month(m[2])) return [+m[3], month(m[2]), +m[1]];
  m = /([a-zäöü]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(text);
  if (m && month(m[1])) return [+m[3], month(m[1]), +m[2]];
  return null;
}

export function parseHeaderDate(text: string): string {
  const input = text.replace(/\s+/g, " ").trim();
  if (NUMERIC_ZONE.test(` ${input}`)) {
    const t = Date.parse(input);
    if (!isNaN(t)) return new Date(t).toISOString();
  }
  const time = TIME.exec(input);
  const parts = dateParts(time ? input.replace(time[0], " ") : input);
  if (!parts) return input;
  let hours = time ? +time[1] : 0;
  const minutes = time ? +time[2] : 0;
  const seconds = time?.[3] ? +time[3] : 0;
  const meridiem = time?.[4]?.[0].toLowerCase();
  if (meridiem) hours = (hours % 12) + (meridiem === "p" ? 12 : 0);
  const [y, mo, d] = parts;
  const check = new Date(y, mo - 1, d, hours, minutes, seconds);
  const valid = check.getFullYear() === y && check.getMonth() === mo - 1 && check.getDate() === d && hours < 24 && minutes < 60 && seconds < 60;
  return valid ? `${y}-${pad(mo)}-${pad(d)}T${pad(hours)}:${pad(minutes)}:${pad(seconds)}` : input;
}

const FORWARD_SEPARATOR = new RegExp(`^[-–—\\s]*(?:${FORWARD_LABELS})[-–—\\s:]*$`, "i");

export function isHeaderSeparator(line: string): boolean {
  const t = line.trim();
  return FORWARD_SEPARATOR.test(t) || ORIGINAL_SEPARATOR.test(t) || /^_{8,}$/.test(t);
}
