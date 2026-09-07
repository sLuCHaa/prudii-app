import { escapeHtml } from "../../lib/sanitize";

/**
 * Pasted content adopts the compose style (like Apple Mail): semantic tags
 * survive, styling is discarded. Clipboard HTML from IDEs/chats carries tens
 * of thousands of styled spans whose style recalc can freeze the webview;
 * oversized pastes fall back to plain text.
 */
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
