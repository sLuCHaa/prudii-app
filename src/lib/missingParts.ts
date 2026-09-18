// Mails that announce files they never carry. Two shapes show up in practice,
// both leaving the body pointing at parts that are not in the message at all:
// - Emacs message-mode writes MML placeholders like
//   `<#part type=image/png filename="/tmp/logo.png">` and turns them into MIME
//   parts on send; where that step is skipped the tags go out as body text and
//   the files never leave the sender's disk.
// - An HTML mail downgraded to plain text on forwarding keeps its `[cid:...]`
//   markers while the parts behind them are dropped.
// Naming the missing files is the point: a dangling reference is otherwise
// indistinguishable from a bug on our side, and the sender needs to hear which
// files to send again.

import type { Attachment } from "../types";
import { normalizeCid, referencedCid } from "./inlineImages";

export type PartSource = Pick<Attachment, "filename" | "content_id">;

export interface MissingParts {
  /** The missing files we could name, in body order, deduplicated. */
  names: string[];
  /** Every reference with no part behind it, including those nothing names. */
  count: number;
}

/** MML tags, whether or not the sender's client quoted its attribute values. */
const MML_TAG = /<#\/?(?:part|multipart|external)\b[^>]*>/g;
/** The same tags plus the `[cid:...]` markers, so matches arrive in body order. */
const TEXT_REF = /<#\/?(?:part|multipart|external)\b[^>]*>|\[cid:([^\]\s]+)\]/g;
const MML_FILENAME = /\bfilename=(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;
const FILENAME_LIKE = /^[^\\/:*?"<>|]+\.[a-z0-9]{2,5}$/i;

interface Ref {
  cid: string | null;
  name: string | null;
}

function basename(path: string): string {
  return path.split(/[\\/]/).pop() ?? "";
}

/** A content id reads `<filename>@<generator>`; Outlook and Apple Mail both put
 *  the real filename in front of the `@`, Gmail an opaque `ii_...` token. */
function filenameFromCid(cid: string | null): string | null {
  if (!cid) return null;
  const at = cid.lastIndexOf("@");
  const local = at > 0 ? cid.slice(0, at) : cid;
  return FILENAME_LIKE.test(local) ? local : null;
}

function filenameFromAlt(alt: string | null): string | null {
  const trimmed = alt?.trim() ?? "";
  return FILENAME_LIKE.test(trimmed) ? trimmed : null;
}

function mmlFilename(tag: string): string | null {
  const m = MML_FILENAME.exec(tag);
  const raw = m ? (m[1] ?? m[2] ?? m[3] ?? "") : "";
  const name = basename(raw.trim());
  return name || null;
}

function htmlRefs(html: string): Ref[] {
  if (!/<img/i.test(html) || !/cid:|Attachment\//i.test(html)) return [];
  const doc = document.implementation.createHTMLDocument("");
  doc.body.innerHTML = html;
  const refs: Ref[] = [];
  doc.body.querySelectorAll("img[src]").forEach((img) => {
    const cid = referencedCid(img.getAttribute("src") ?? "");
    if (cid === null) return;
    refs.push({ cid, name: filenameFromCid(cid) ?? filenameFromAlt(img.getAttribute("alt")) });
  });
  return refs;
}

function textRefs(text: string): Ref[] {
  if (!text.includes("<#") && !/\[cid:/i.test(text)) return [];
  const refs: Ref[] = [];
  for (const m of text.matchAll(TEXT_REF)) {
    if (m[1] !== undefined) {
      // Plain text carries no proof an unnamed marker ever stood for a file.
      const name = filenameFromCid(m[1]);
      if (name) refs.push({ cid: m[1], name });
      continue;
    }
    const name = mmlFilename(m[0]);
    if (name) refs.push({ cid: null, name });
  }
  return refs;
}

/** Files the body announces that the message does not carry. An attachment the
 *  list knows counts as carried even before its bytes are downloaded — during
 *  that window the body still points at a cid nothing has resolved yet. */
export function findMissingParts(
  mail: { body_html?: string | null; body_text?: string | null },
  attachments: readonly PartSource[],
): MissingParts {
  const refs = [...htmlRefs(mail.body_html ?? ""), ...textRefs(mail.body_text ?? "")];
  if (refs.length === 0) return { names: [], count: 0 };

  const cids = new Set(attachments.filter((a) => a.content_id).map((a) => normalizeCid(a.content_id!)));
  const files = new Set(attachments.map((a) => a.filename.toLowerCase()));

  const names: string[] = [];
  const seen = new Set<string>();
  let count = 0;
  for (const ref of refs) {
    if (ref.cid && cids.has(normalizeCid(ref.cid))) continue;
    if (ref.name && files.has(ref.name.toLowerCase())) continue;
    const key = (ref.name ?? ref.cid ?? "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    count++;
    if (ref.name) names.push(ref.name);
  }
  return { names, count };
}

/** Drop the MML tags from a body so the text around them stays readable. The
 *  raw form remains available in the source view. */
export function stripMmlTags(text: string): string {
  if (!text.includes("<#")) return text;
  const stripped = text.replace(MML_TAG, "");
  if (stripped === text) return text;
  return stripped
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+$/, "");
}
