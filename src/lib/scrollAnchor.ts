export interface ScrollAnchor {
  key: string;
  offset: number;
}

interface Row {
  index: number;
  start: number;
  end: number;
}

/** The row at the top edge and how far it is scrolled past; null at the very top. */
export function anchorAt(rows: Row[], keyOf: (index: number) => string | null, top: number): ScrollAnchor | null {
  if (top <= 0) return null;
  for (const row of rows) {
    if (row.end <= top) continue;
    const key = keyOf(row.index);
    return key === null ? null : { key, offset: top - row.start };
  }
  return null;
}
