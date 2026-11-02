// Mirrors the backend's word split (sanitize_fts_query): each whitespace word, quotes dropped; addresses search headers, not text.
export function searchTerms(query: string): string[] {
  const terms = query
    .split(/\s+/)
    .map((word) => word.replace(/"/g, ""))
    .filter((word) => word.length >= 2 && !word.includes("@"));
  return [...new Set(terms.map((t) => t.toLowerCase()))].sort((a, b) => b.length - a.length);
}

export function termPattern(terms: string[]): RegExp | null {
  if (terms.length === 0) return null;
  return new RegExp(terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
}

/** Text split into plain and matching parts, in order. */
export function splitMatches(text: string, pattern: RegExp | null): { text: string; hit: boolean }[] {
  if (!pattern || !text) return [{ text, hit: false }];
  const parts: { text: string; hit: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(pattern)) {
    const at = m.index ?? 0;
    if (at > last) parts.push({ text: text.slice(last, at), hit: false });
    parts.push({ text: m[0], hit: true });
    last = at + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hit: false });
  return parts.length ? parts : [{ text, hit: false }];
}

const MARK = "mark[data-prudii-hl]";

/** Wraps every match in the document's text in a mark, replacing any earlier marks. */
export function markDocument(doc: Document, pattern: RegExp | null): number {
  doc.querySelectorAll(MARK).forEach((mark) => mark.replaceWith(...Array.from(mark.childNodes)));
  doc.body?.normalize();
  if (!pattern || !doc.body) return 0;
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => (node.parentElement?.closest("script, style, mark") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const nodes: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) nodes.push(n as Text);
  let count = 0;
  for (const node of nodes) {
    const parts = splitMatches(node.data, pattern);
    if (!parts.some((p) => p.hit)) continue;
    const frag = doc.createDocumentFragment();
    for (const part of parts) {
      if (!part.hit) {
        frag.append(part.text);
        continue;
      }
      const mark = doc.createElement("mark");
      mark.setAttribute("data-prudii-hl", "");
      mark.textContent = part.text;
      frag.append(mark);
      count++;
    }
    node.replaceWith(frag);
  }
  return count;
}
