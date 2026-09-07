import type { ReactNode } from "react";

export type MenuItem = {
  kind: "item";
  id: string;
  label: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  selected?: boolean;
  onSelect?: () => void;
  submenu?: MenuEntry[];
};

export type MenuEntry = MenuItem | { kind: "separator" } | { kind: "header"; label: string; icon?: ReactNode };

export function isFocusable(entry: MenuEntry): entry is MenuItem {
  return entry.kind === "item" && !entry.disabled;
}

export function moveFocus(entries: MenuEntry[], current: number, key: "ArrowDown" | "ArrowUp" | "Home" | "End"): number {
  const idx = entries.map((e, i) => (isFocusable(e) ? i : -1)).filter((i) => i >= 0);
  if (idx.length === 0) return -1;
  if (key === "Home") return idx[0];
  if (key === "End") return idx[idx.length - 1];
  const pos = idx.indexOf(current);
  if (key === "ArrowDown") return pos === -1 || pos === idx.length - 1 ? idx[0] : idx[pos + 1];
  return pos <= 0 ? idx[idx.length - 1] : idx[pos - 1];
}

export function typeaheadIndex(entries: MenuEntry[], current: number, query: string): number {
  const q = query.toLowerCase();
  if (!q) return -1;
  const n = entries.length;
  for (let step = 1; step <= n; step++) {
    const i = (current + step + n) % n;
    const e = entries[i];
    if (isFocusable(e) && e.label.toLowerCase().startsWith(q)) return i;
  }
  return -1;
}

export function clampToViewport(x: number, y: number, w: number, h: number, vw: number, vh: number, margin = 8) {
  return {
    left: Math.max(margin, Math.min(x, vw - w - margin)),
    top: Math.max(margin, Math.min(y, vh - h - margin)),
  };
}

// Submenus overlap the parent edge by 4px like native flyouts; flip left when
// the right side has no room.
export function submenuPosition(anchor: { left: number; top: number; right: number }, w: number, h: number, vw: number, vh: number, margin = 8) {
  const left = anchor.right - 4 + w + margin <= vw ? anchor.right - 4 : anchor.left + 4 - w;
  const top = Math.max(margin, Math.min(anchor.top - 4, vh - h - margin));
  return { left, top };
}
