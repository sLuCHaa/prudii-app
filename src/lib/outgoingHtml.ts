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
 * face (Bahnschrift on Windows 10 and later; Apple platforms lack it and get
 * Avenir Next). Keep in sync with `.compose-writing` in index.css, which gives
 * subject and recipients the default body font.
 */
export const OUTGOING_FONT_STACK =
  "Bahnschrift, 'Avenir Next', Avenir, 'Segoe UI', sans-serif";

/**
 * Fonts the user can pick for outgoing mail. Apart from the Prudii default,
 * every stack leads with a face that ships with Windows and macOS alike, so the
 * recipient sees the same font the sender chose.
 */
export const COMPOSE_FONTS = {
  prudii: { label: "Prudii", stack: OUTGOING_FONT_STACK },
  arial: { label: "Arial", stack: "Arial, Helvetica, sans-serif" },
  verdana: { label: "Verdana", stack: "Verdana, Geneva, sans-serif" },
  trebuchet: { label: "Trebuchet MS", stack: "'Trebuchet MS', Helvetica, sans-serif" },
  georgia: { label: "Georgia", stack: "Georgia, 'Times New Roman', serif" },
  times: { label: "Times New Roman", stack: "'Times New Roman', Times, serif" },
  courier: { label: "Courier New", stack: "'Courier New', Courier, monospace" },
} as const;

export type ComposeFontId = keyof typeof COMPOSE_FONTS;

export const COMPOSE_FONT_SIZES = [10, 11, 12, 14, 16] as const;
export const DEFAULT_COMPOSE_FONT_SIZE = 11;

/** Keep in sync with `.compose-editor .tiptap` in index.css. */
export const OUTGOING_LINE_HEIGHT = "1.5";

export interface ComposeTypography {
  fontStack: string;
  fontSizePt: number;
}

export function composeTypography(fontId: string, fontSizePt: number): ComposeTypography {
  const font = Object.prototype.hasOwnProperty.call(COMPOSE_FONTS, fontId) ? COMPOSE_FONTS[fontId as ComposeFontId] : COMPOSE_FONTS.prudii;
  const size = (COMPOSE_FONT_SIZES as readonly number[]).includes(fontSizePt) ? fontSizePt : DEFAULT_COMPOSE_FONT_SIZE;
  return { fontStack: font.stack, fontSizePt: size };
}

const OUTGOING_MARGIN = "margin:0 0 0.5em 0";

/**
 * Stamp the editor's paragraph spacing and typography onto the outgoing HTML.
 *
 * The editor styles paragraphs via its stylesheet (`margin: 0 0 0.5em`), but a
 * stylesheet does not travel with the mail — recipients fall back to the UA
 * default of `1em 0`, which renders every break twice as wide as composed, and
 * to their own default font size, which differs per client (Gmail 13px,
 * Outlook 12pt). Inline declarations are the only styling that survives all
 * mail clients. Existing declarations win: a paragraph that already carries one
 * of these properties keeps it, which also makes this idempotent. Same contract
 * as fillEmptyParagraphs: targeted string replacement on editor output only —
 * never applied to quoted foreign HTML.
 */
export function inlineComposeStyles(html: string, typography: ComposeTypography): string {
  return html.replace(/<p(\s[^>]*)?>/gi, (tag: string, attrs: string | undefined) => {
    const attrStr = attrs ?? "";
    const styleMatch = attrStr.match(/style\s*=\s*(["'])(.*?)\1/i);
    const existing = styleMatch ? styleMatch[2] : "";
    const delim = styleMatch ? styleMatch[1] : '"';
    // The stack quotes font names with the character the attribute is NOT using.
    const stack = delim === "'" ? typography.fontStack.replace(/'/g, '"') : typography.fontStack;
    const additions: string[] = [];
    if (!/margin/i.test(existing)) additions.push(OUTGOING_MARGIN);
    if (!/font-family/i.test(existing)) additions.push(`font-family:${stack}`);
    if (!/font-size/i.test(existing)) additions.push(`font-size:${typography.fontSizePt}pt`);
    if (!/line-height/i.test(existing)) additions.push(`line-height:${OUTGOING_LINE_HEIGHT}`);
    if (additions.length === 0) return tag;
    if (!styleMatch) return `<p${attrStr} style="${additions.join(";")}">`;
    const merged = `${additions.join(";")};${existing}`;
    return `<p${attrStr.replace(styleMatch[0], `style=${delim}${merged}${delim}`)}>`;
  });
}

const SIGNATURE_OPEN = '<div data-type="signature">';
const DIVIDER_MARK = "data-prudii-divider";

/**
 * Set the signature apart with a short line in the sender's accent colour.
 *
 * A table, because Outlook on Windows ignores `width` on a div and would
 * stretch the line across the mail; each cell carries its own text size so
 * Outlook keeps it at its height. Reopening a draft drops the line again
 * (SignatureNode), so it never piles up.
 */
export function addSignatureDivider(html: string, color: string): string {
  const start = html.indexOf(SIGNATURE_OPEN);
  if (start < 0) return html;
  const contentStart = start + SIGNATURE_OPEN.length;
  const end = html.indexOf("</div>", contentStart);
  const content = html.slice(contentStart, end < 0 ? html.length : end);
  if (content.includes(DIVIDER_MARK)) return html;
  const visible = /<img\b/i.test(content) || content.replace(/<[^>]*>/g, "").replace(/&nbsp;|\s/g, "") !== "";
  if (!visible) return html;
  const spacer = (px: number) =>
    `<tr><td height="${px}" style="height:${px}px;font-size:${px}px;line-height:${px}px;mso-line-height-rule:exactly">&nbsp;</td></tr>`;
  const line = `<tr><td width="48" height="2" bgcolor="${color}" style="width:48px;height:2px;background-color:${color};font-size:2px;line-height:2px;mso-line-height-rule:exactly">&nbsp;</td></tr>`;
  const divider = `<table ${DIVIDER_MARK} role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse">${spacer(20)}${line}${spacer(14)}</table>`;
  return html.slice(0, contentStart) + divider + html.slice(contentStart);
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

export interface DataImageRef {
  cid: string;
  type: string;
  data: string;
  name: string;
}

const DATA_IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

// The backend decodes strictly, so only canonical base64 may become a part; anything else stays data:.
function strictBase64(raw: string): string | null {
  const data = raw.replace(/\s+/g, "");
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return null;
  try {
    return btoa(atob(data)) === data ? data : null;
  } catch {
    return null;
  }
}

/**
 * Rewrite base64 `data:` image sources to `cid:` references and report the
 * bytes so the caller can attach them as inline parts — many clients do not
 * display data: URIs. Same targeted string replacement as extractLocalImages.
 */
export function extractDataImages(html: string): { html: string; images: DataImageRef[] } {
  const images: DataImageRef[] = [];
  const cidByData = new Map<string, string>();

  const out = html.replace(
    /(<img\b[^>]*?\bsrc=)(["'])data:(image\/[a-z0-9.+-]+);base64,([^"']+)\2/gi,
    (m, pre: string, quote: string, type: string, raw: string) => {
      const mime = type.toLowerCase();
      const ext = DATA_IMAGE_EXT[mime];
      const data = ext ? strictBase64(raw) : null;
      if (!ext || !data) return m;
      const key = `${mime};${data}`;
      let cid = cidByData.get(key);
      if (!cid) {
        const n = images.length + 1;
        cid = `embedded-${n}@prudii`;
        cidByData.set(key, cid);
        images.push({ cid, type: mime, data, name: `image-${n}.${ext}` });
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
  // Bodies stored before the backend built these properly carry a fourth slash
  // ("file:////Users/..."), which must not survive into the path.
  if (path.startsWith("//")) path = path.replace(/^\/+/, "/");
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
