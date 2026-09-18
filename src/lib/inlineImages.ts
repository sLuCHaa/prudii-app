// Inline-image references the fetch-time rewrite (plain cid: only) cannot know
// about, resolved at render time against the mail's attachments:
// - GMX/WEB.DE apps forward Outlook mails with the cid base64-wrapped in their
//   own "Attachment/<token>" scheme.
// - Apple Mail forwards reference a blob: URL of the sender's session; when the
//   file was attached too, the alt text carries its name.
// - Images declared application/octet-stream fail the fetcher's image check.

import type { Attachment } from "../types";
import { decodeFileUrl } from "./outgoingHtml";

export type InlineSource = Pick<Attachment, "filename" | "content_id" | "local_path" | "mime_type">;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|avif|heic|tiff?)$/i;

function looksLikeImage(a: InlineSource): boolean {
  return (a.mime_type?.toLowerCase().startsWith("image/") ?? false) || IMAGE_EXT.test(a.filename);
}

function fileUrl(path: string): string {
  const posix = path.replace(/\\/g, "/").replace(/^\/+/, "");
  return "file:///" + posix;
}

export function normalizeCid(cid: string): string {
  return cid.trim().replace(/^<|>$/g, "").toLowerCase();
}

function decodeBase64(token: string): string | null {
  const std = token.replace(/-/g, "+").replace(/_/g, "/");
  try {
    return atob(std + "=".repeat((4 - (std.length % 4)) % 4));
  } catch {
    return null;
  }
}

/** The content id an <img> source points at, through the GMX wrapper if need be. */
export function referencedCid(src: string): string | null {
  if (/^cid:/i.test(src)) return src.slice(4);
  const wrapped = /^Attachment\/([A-Za-z0-9+/_=-]+)$/.exec(src);
  if (!wrapped) return null;
  const decoded = decodeBase64(wrapped[1]);
  return decoded && /^cid:/i.test(decoded) ? decoded.slice(4) : null;
}

/** Point img sources that refer to the mail's own attachments at the stored files. */
export function resolveInlineImages(root: ParentNode, attachments: readonly InlineSource[]): void {
  const byCid = new Map<string, string>();
  const byName = new Map<string, string>();
  for (const a of attachments) {
    if (!a.local_path) continue;
    if (a.content_id) byCid.set(normalizeCid(a.content_id), a.local_path);
    // Only the filename match needs the image check; a cid reference from <img> is proof enough.
    if (looksLikeImage(a)) byName.set(a.filename.toLowerCase(), a.local_path);
  }
  if (byCid.size === 0 && byName.size === 0) return;

  root.querySelectorAll("img[src]").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    const cid = referencedCid(src);
    let path: string | undefined;
    if (cid !== null) {
      path = byCid.get(normalizeCid(cid));
    } else if (/^blob:/i.test(src)) {
      const alt = img.getAttribute("alt")?.trim().toLowerCase();
      if (alt) path = byName.get(alt);
    }
    if (path) img.setAttribute("src", fileUrl(path));
  });
}

/** Drop images whose source only the sender's own client could load. Returns the count. */
export function removeUnresolvableImages(root: ParentNode): number {
  let removed = 0;
  root.querySelectorAll("img[src]").forEach((img) => {
    if (/^(cid:|blob:|Attachment\/)/i.test(img.getAttribute("src") ?? "")) {
      img.remove();
      removed++;
    }
  });
  return removed;
}

/** String form for the compose quote. Parsed in an inert document, so nothing
 *  in the mail loads or runs; returns the input itself when nothing needs work. */
export function resolveInlineImagesInHtml(html: string, attachments: readonly InlineSource[]): string {
  if (!/cid:|blob:|Attachment\//.test(html)) return html;
  const doc = document.implementation.createHTMLDocument("");
  doc.body.innerHTML = html;
  resolveInlineImages(doc.body, attachments);
  removeUnresolvableImages(doc.body);
  return doc.body.innerHTML;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase();
}

/** Local paths of the attachments the body displays, in any of the reference forms above. */
function displayedPaths(html: string, attachments: readonly InlineSource[]): Set<string> {
  const paths = new Set<string>();
  if (!/<img/i.test(html)) return paths;
  const doc = document.implementation.createHTMLDocument("");
  doc.body.innerHTML = html;
  resolveInlineImages(doc.body, attachments);
  doc.body.querySelectorAll("img[src]").forEach((img) => {
    const src = img.getAttribute("src") ?? "";
    if (/^file:\/\//i.test(src)) paths.add(normalizePath(decodeFileUrl(src)));
  });
  return paths;
}

/** What the attachment list shows: everything not inline, plus inline images we
 *  only *inferred* were inline and the body never displays. Non-image inline
 *  parts (S/MIME signatures) stay hidden.
 *
 *  The body check exists because inline-ness used to be inferred from a
 *  Content-ID, which Exchange stamps on genuine attachments too — real photos
 *  went missing. Where the sender declared `Content-Disposition: inline` there
 *  is nothing to second-guess, and demanding proof from the body actively hurts:
 *  Apple Mail points its signature images at a blob: URL of the sender's own
 *  session, so they can never be matched and were listed as attachments.
 *
 *  `declared_inline` is absent on rows stored before the column existed; those
 *  keep the body check until the mail is synced again. */
export function listedAttachments<T extends InlineSource & { is_inline: boolean; declared_inline?: boolean }>(html: string, attachments: readonly T[]): T[] {
  const inlineImages = attachments.filter((a) => a.is_inline && looksLikeImage(a));
  const displayed = inlineImages.length > 0 ? displayedPaths(html, inlineImages) : new Set<string>();
  return attachments.filter((a) => {
    if (!a.is_inline) return true;
    if (!looksLikeImage(a)) return false;
    if (a.declared_inline) return false;
    return !(a.local_path && displayed.has(normalizePath(a.local_path)));
  });
}
