import { escapeHtml } from "../../lib/sanitize";

/** Pasted content adopts the editor's style: semantic tags survive, styling is
 *  discarded; an oversized paste falls back to plain text (style recalc freezes the webview). */
export function cleanPastedHtml(html: string): string {
  if (html.length > 400_000) {
    const text = new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";
    return `<p>${escapeHtml(text).replace(/\n/g, "<br>")}</p>`;
  }
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("style, script, link, meta, title").forEach((el) => el.remove());
  doc.body.querySelectorAll("*").forEach((el) => {
    el.removeAttribute("style");
    el.removeAttribute("class");
  });
  return doc.body.innerHTML;
}
