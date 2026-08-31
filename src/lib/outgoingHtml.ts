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

/**
 * Font stack for outgoing mail — distinctive but degrading gracefully: only
 * fonts the recipient has installed can render, so every entry is an OS-bundled
 * face (Avenir Next on Apple platforms, Candara/Segoe on Windows). Keep in sync
 * with `.compose-editor .tiptap` in index.css so the editor shows the truth.
 */
export const OUTGOING_FONT_STACK =
  "'Avenir Next', Avenir, Candara, 'Segoe UI', 'Trebuchet MS', Verdana, sans-serif";

const OUTGOING_MARGIN = "margin:0 0 0.5em 0";

/**
 * Stamp the editor's paragraph spacing and font onto the outgoing HTML.
 *
 * The editor styles paragraphs via its stylesheet (`margin: 0 0 0.5em`), but a
 * stylesheet does not travel with the mail — recipients fall back to the UA
 * default of `1em 0`, which renders every break twice as wide as composed.
 * Inline declarations are the only styling that survives all mail clients.
 * Existing declarations win: a paragraph that already carries a margin or
 * font-family keeps it, which also makes this idempotent. Same contract as
 * fillEmptyParagraphs: targeted string replacement on editor output only —
 * never applied to quoted foreign HTML.
 */
export function inlineComposeStyles(html: string): string {
  return html.replace(/<p(\s[^>]*)?>/gi, (tag: string, attrs: string | undefined) => {
    const attrStr = attrs ?? "";
    const styleMatch = attrStr.match(/style\s*=\s*(["'])(.*?)\1/i);
    const existing = styleMatch ? styleMatch[2] : "";
    const delim = styleMatch ? styleMatch[1] : '"';
    // The stack quotes font names with the character the attribute is NOT using.
    const stack = delim === "'" ? OUTGOING_FONT_STACK.replace(/'/g, '"') : OUTGOING_FONT_STACK;
    const additions: string[] = [];
    if (!/margin/i.test(existing)) additions.push(OUTGOING_MARGIN);
    if (!/font-family/i.test(existing)) additions.push(`font-family:${stack}`);
    if (additions.length === 0) return tag;
    if (!styleMatch) return `<p${attrStr} style="${additions.join(";")}">`;
    const merged = `${additions.join(";")};${existing}`;
    return `<p${attrStr.replace(styleMatch[0], `style=${delim}${merged}${delim}`)}>`;
  });
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
