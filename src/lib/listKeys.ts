export type ListNavKey = "ArrowDown" | "ArrowUp" | "Home" | "End" | "PageUp" | "PageDown";

const NAV_KEYS: ReadonlySet<string> = new Set(["ArrowDown", "ArrowUp", "Home", "End", "PageUp", "PageDown"]);

export function isListNavKey(key: string): key is ListNavKey {
  return NAV_KEYS.has(key);
}

export function nextCursor(current: number, count: number, key: ListNavKey, pageSize: number): number {
  if (count <= 0) return -1;
  const last = count - 1;
  if (current < 0) return key === "End" ? last : 0;
  switch (key) {
    case "ArrowDown": return Math.min(current + 1, last);
    case "ArrowUp": return Math.max(current - 1, 0);
    case "Home": return 0;
    case "End": return last;
    case "PageDown": return Math.min(current + pageSize, last);
    case "PageUp": return Math.max(current - pageSize, 0);
  }
}

// A page is the number of whole rows visible; a tiny viewport still moves.
export function pageSize(viewportHeight: number, rowHeight: number): number {
  return Math.max(1, Math.floor(viewportHeight / rowHeight));
}

export function spanIds<T extends { id: string }>(items: T[], anchorIdx: number, cursorIdx: number): string[] {
  if (items.length === 0) return [];
  const clamp = (i: number) => Math.min(Math.max(i, 0), items.length - 1);
  const a = clamp(anchorIdx);
  const b = clamp(cursorIdx);
  return items.slice(Math.min(a, b), Math.max(a, b) + 1).map((m) => m.id);
}
