import type { SearchResult } from "../types";

/**
 * Local hits come first in a tie because they carry the highlighted snippet;
 * the server only adds what the local index could not see.
 */
export function mergeSearchResults(
  local: SearchResult[] | undefined,
  remote: SearchResult[] | undefined,
  limit = 100,
): SearchResult[] | undefined {
  if (!local && !remote) return undefined;
  const seen = new Set<string>();
  const merged: SearchResult[] = [];
  for (const hit of [...(local ?? []), ...(remote ?? [])]) {
    if (seen.has(hit.mail_id)) continue;
    seen.add(hit.mail_id);
    merged.push(hit);
  }
  merged.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return merged.slice(0, limit);
}
