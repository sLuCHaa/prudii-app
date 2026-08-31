// Last-mile fixes for HTML that is about to leave the app as a sent mail.
//
// Nothing here may be applied to HTML that flows back into the editor — the
// editor re-parses what it is given, and these transformations are written to
// be read by other mail clients, not by us.

/**
 * Give empty paragraphs a line break so they render as blank lines.
 *
 * The editor serialises a blank line as `<p></p>`. Such a paragraph has no
 * content, no padding and no border, so its top and bottom margins collapse
 * through it and merge with the neighbouring paragraphs' margins: it occupies
 * zero height and adds no visible gap. The blank line is present in the markup
 * but cannot render, in any correct renderer — this is not an Outlook quirk.
 * Every other mail client avoids it by putting a `<br>` or `&nbsp;` inside.
 *
 * Deliberately a targeted string replacement rather than a DOM round-trip:
 * the outgoing body carries a signature with a base64 image and is never
 * parsed again, so everything the transformation does not explicitly target
 * must stay byte-identical. Parsing and re-serialising would silently
 * renormalise quoting, tag case and self-closing tags.
 *
 * A paragraph already holding a `<br>`, an `&nbsp;` or any text is left alone,
 * which also makes this idempotent.
 */
export function fillEmptyParagraphs(html: string): string {
  // `[^>]*` for the attributes assumes no attribute value contains a literal
  // `>`, which holds for what the editor produces.
  return html.replace(/<p([^>]*)>\s*<\/p>/gi, "<p$1><br></p>");
}

export interface LocalImageRef {
  /** Absolute local path of the stored attachment file. */
  path: string;
  /** Content-ID assigned for the outgoing message (without angle brackets). */
  cid: string;
}

/**
 * Rewrite `file://` image sources to `cid:` references and report the local
 * paths so the caller can attach the files as inline parts.
 *
 * Quoted reply/forward HTML carries embedded images (signature logos etc.) as
 * `file://` paths — the backend rewrote their cid: references to the locally
 * stored files for display. Sending those paths verbatim leaks the local
 * filesystem layout to the recipient and renders as broken images on their
 * machine; every further reply then quotes the broken reference onward.
 *
 * Same contract as fillEmptyParagraphs: targeted string replacement, never a
 * DOM round-trip — everything not explicitly matched stays byte-identical.
 */
export function extractLocalImages(html: string): { html: string; images: LocalImageRef[] } {
  const images: LocalImageRef[] = [];
  const cidByPath = new Map<string, string>();

  const out = html.replace(
    /(<img\b[^>]*?\bsrc=)(["'])(file:\/\/[^"']+)\2/gi,
    (_m, pre: string, quote: string, src: string) => {
      const path = decodeFileUrl(src);
      let cid = cidByPath.get(path);
      if (!cid) {
        cid = `inline-${cidByPath.size + 1}@prudii`;
        cidByPath.set(path, cid);
        images.push({ path, cid });
      }
      return `${pre}${quote}cid:${cid}${quote}`;
    }
  );

  return { html: out, images };
}

export function decodeFileUrl(src: string): string {
  // The backend writes raw platform paths ("file://C:\..."), but HTML that
  // passed through the editor may come back percent-encoded and with the
  // three-slash form ("file:///C:/...").
  let path = src.slice("file://".length);
  if (/^\/[A-Za-z]:/.test(path)) path = path.slice(1);
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

/** Remove the `<img>` tags whose cid: reference could not be resolved to a file. */
export function dropImagesByCid(html: string, cids: string[]): string {
  let out = html;
  for (const cid of cids) {
    const escaped = cid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp(`<img\\b[^>]*\\bsrc=(["'])cid:${escaped}\\1[^>]*>`, "gi"), "");
  }
  return out;
}
