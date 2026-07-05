// Tracks the last N invoked command IDs in localStorage so the palette can
// suggest them when the query is empty.

const KEY = "prudii.commandRecent";
const MAX = 5;

export function getRecentCommands(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s) => typeof s === "string") : [];
  } catch {
    return [];
  }
}

export function recordCommandRun(id: string): void {
  const cur = getRecentCommands().filter((x) => x !== id);
  cur.unshift(id);
  const next = cur.slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // localStorage may throw in quota cases — silently ignore
  }
}
