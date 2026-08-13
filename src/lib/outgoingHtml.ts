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
