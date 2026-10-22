import type { MailAddress } from "../types";
import { headerLabel, isHeaderSeparator, parseAddressList, parseHeaderDate, parseMailbox, type HeaderField } from "./embeddedHeader";
import { hasVisible, visibleText } from "./quotedHistory";

export interface EmbeddedMail {
  from: MailAddress;
  to: MailAddress[];
  cc: MailAddress[];
  date: string;
  subject: string;
  header: string;
  html: string;
  quote(): string;
  preview: string;
}

export interface SplitMail {
  outer: string;
  parts: EmbeddedMail[];
}

interface Pos {
  node: Node;
  offset: number;
}

interface Line {
  text: string;
  start: Pos | null;
  end: Pos | null;
}

interface Block {
  start: Pos;
  end: Pos;
  fields: Map<HeaderField, string[]>;
  header: string;
}

const SKIPPED = new Set(["STYLE", "SCRIPT", "TITLE", "META", "LINK", "TEMPLATE"]);
const BREAKING = new Set(["DIV", "P", "TABLE", "UL", "OL", "PRE", "BLOCKQUOTE", "HR", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "HEADER", "FOOTER", "CENTER", "LI", "TR"]);
const QUOTE_WRAPPER = "blockquote, .gmail_quote, .gmail_quote_container, [type=cite], .moz-forward-container";
const MEDIA_TAGS = new Set(["img", "video", "picture", "svg"]);
const VISIBLE_CHAR = /[^\s​-‍﻿]/;
const MIN_LABELS = 3;
const HAS_EMAIL = /[^\s<>@]+@[^\s<>@]+/;
const PREVIEW_LENGTH = 140;

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();

function linearise(body: HTMLElement): Line[] {
  const lines: Line[] = [];
  let text = "";
  let start: Pos | null = null;
  let end: Pos | null = null;
  let substantive = false;

  const flush = (force = false) => {
    if (substantive || force) lines.push({ text: collapse(text), start, end });
    text = "";
    start = end = null;
    substantive = false;
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const value = node.nodeValue ?? "";
      if (/[^ \t\r\n\f]/.test(value)) substantive = true;
      const first = value.search(VISIBLE_CHAR);
      if (first >= 0) {
        const last = value.length - [...value].reverse().join("").search(VISIBLE_CHAR);
        start ??= { node, offset: first };
        end = { node, offset: last };
      }
      text += value;
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const tag = (node as Element).tagName;
    if (SKIPPED.has(tag)) return;
    if (tag === "BR") {
      flush(true);
      return;
    }
    const breaking = BREAKING.has(tag);
    if (breaking) flush();
    node.childNodes.forEach(walk);
    if (breaking) flush();
    else if (tag === "TD" || tag === "TH") text += " ";
  };

  walk(body);
  flush();
  return lines;
}

const isBlank = (line: Line) => line.text === "";

function findBlocks(lines: Line[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (!headerLabel(lines[i].text)) {
      i++;
      continue;
    }
    const run = [i];
    let blanks = 0;
    for (let j = i + 1; j < lines.length; j++) {
      if (isBlank(lines[j])) {
        if (++blanks > 1) break;
      } else if (headerLabel(lines[j].text)) {
        run.push(j);
        blanks = 0;
      } else {
        break;
      }
    }
    i = run[run.length - 1] + 1;

    const fields = new Map<HeaderField, string[]>();
    for (const index of run) {
      const label = headerLabel(lines[index].text)!;
      fields.set(label.field, [...(fields.get(label.field) ?? []), label.value]);
    }
    if (run.length < MIN_LABELS || !fields.has("from") || !(fields.has("date") || fields.has("to"))) continue;

    let first = run[0];
    let before = first - 1;
    while (before >= 0 && isBlank(lines[before])) before--;
    const separated = before >= 0 && isHeaderSeparator(lines[before].text);
    if (separated) first = before;
    if (!separated && !fields.has("subject") && !fields.get("from")!.some((v) => HAS_EMAIL.test(v))) continue;

    const last = lines[run[run.length - 1]];
    blocks.push({
      start: lines[first].start!,
      end: last.end!,
      fields,
      header: collapse(lines.slice(first, run[run.length - 1] + 1).map((l) => l.text).join(" ")),
    });
  }
  return blocks;
}

function seen(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) return VISIBLE_CHAR.test(node.nodeValue ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  if (SKIPPED.has(el.tagName)) return false;
  if (MEDIA_TAGS.has(el.localName)) return hasVisible(el);
  for (let child = el.firstChild; child; child = child.nextSibling) if (seen(child)) return true;
  return false;
}

function trimEdge(root: Node, edge: "firstChild" | "lastChild") {
  let parent = root;
  for (;;) {
    const child = parent[edge];
    if (!child) return;
    if (!seen(child)) {
      parent.removeChild(child);
      continue;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    parent = child;
  }
}

function clean(fragment: DocumentFragment, doc: Document): HTMLElement {
  const box = doc.createElement("div");
  box.appendChild(fragment);
  box.querySelectorAll("style").forEach((s) => s.remove());
  for (;;) {
    trimEdge(box, "firstChild");
    trimEdge(box, "lastChild");
    const visible = Array.from(box.childNodes).filter(seen);
    const only = visible.length === 1 && visible[0].nodeType === Node.ELEMENT_NODE ? (visible[0] as Element) : null;
    if (!only?.matches(QUOTE_WRAPPER)) return box;
    only.replaceWith(...Array.from(only.childNodes));
  }
}

function address(values: string[] | undefined): MailAddress[] {
  return (values ?? []).flatMap(parseAddressList);
}

function split(html: string): SplitMail | null {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const body = doc.body;
  const blocks = findBlocks(linearise(body));
  if (blocks.length === 0) return null;

  const styles = Array.from(doc.querySelectorAll("style")).map((s) => s.outerHTML).join("");
  const cut = (from: Pos | null, to: Pos | null) => {
    const range = doc.createRange();
    if (from) range.setStart(from.node, from.offset);
    else range.setStart(body, 0);
    if (to) range.setEnd(to.node, to.offset);
    else range.setEnd(body, body.childNodes.length);
    return clean(range.cloneContents(), doc);
  };

  const outerBox = cut(null, blocks[0].start);
  const parts = blocks.map((block, i): EmbeddedMail => {
    const own = cut(block.end, blocks[i + 1]?.start ?? null);
    const html = styles + own.innerHTML;
    let quote: string | undefined;
    return {
      from: parseMailbox(block.fields.get("from")?.[0] ?? "") ?? { name: "", email: "" },
      to: address(block.fields.get("to")),
      cc: address(block.fields.get("cc")),
      date: parseHeaderDate(block.fields.get("date")?.[0] ?? ""),
      subject: block.fields.get("subject")?.[0] ?? "",
      header: block.header,
      html,
      // Cut on first use (every level repeats the whole chain below it); the part's own text if the cut fails.
      quote() {
        if (quote === undefined) {
          try {
            quote = styles + cut(block.end, null).innerHTML;
          } catch {
            quote = html;
          }
        }
        return quote;
      },
      preview: collapse(visibleText(own)).slice(0, PREVIEW_LENGTH),
    };
  });
  return { outer: seen(outerBox) ? styles + outerBox.innerHTML : "", parts };
}

export function splitEmbeddedMails(html: string): SplitMail | null {
  try {
    return split(html);
  } catch {
    return null;
  }
}
