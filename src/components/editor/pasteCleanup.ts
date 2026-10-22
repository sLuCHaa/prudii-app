import { escapeHtml } from "../../lib/sanitize";

const SIGNATURE = 'div[data-type="signature"]';

/** Pasted content adopts the editor's style: semantic tags survive, styling is
 *  discarded; an oversized paste falls back to plain text (style recalc freezes the webview). */
export function cleanPastedHtml(html: string): string {
  if (html.length > 400_000) {
    const text = new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
    return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style, script, link, meta, title").forEach((el) => el.remove());
  // ProseMirror marks the editor's own copies; a signature from anywhere else becomes editable content.
  const own = doc.querySelector("[data-pm-slice]") !== null;
  if (!own) doc.querySelectorAll(SIGNATURE).forEach((el) => el.removeAttribute("data-type"));
  doc.body.querySelectorAll("*").forEach((el) => {
    if (own && el.closest(SIGNATURE)) return;
    el.removeAttribute("style");
    el.removeAttribute("class");
  });
  return doc.body.innerHTML;
}
