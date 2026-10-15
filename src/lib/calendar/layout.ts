export const MIN_ITEM_MINUTES = 20;

export interface TimedItem {
  id: string;
  startMin: number;
  endMin: number;
}

export interface Placement {
  col: number;
  cols: number;
}

/** Columns for overlapping items; a cluster is a run of transitively overlapping items. */
export function layoutDay(items: TimedItem[], minMinutes = MIN_ITEM_MINUTES): Map<string, Placement> {
  const sorted = items
    .map((i) => ({ ...i, endMin: Math.max(i.endMin, i.startMin + minMinutes) }))
    .sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin);
  const result = new Map<string, Placement>();
  let cluster: { id: string; col: number }[] = [];
  let colEnds: number[] = [];
  let clusterEnd = -1;
  const flush = () => {
    for (const c of cluster) result.set(c.id, { col: c.col, cols: colEnds.length });
    cluster = [];
    colEnds = [];
    clusterEnd = -1;
  };
  for (const item of sorted) {
    if (cluster.length > 0 && item.startMin >= clusterEnd) flush();
    let col = colEnds.findIndex((end) => end <= item.startMin);
    if (col === -1) {
      col = colEnds.length;
      colEnds.push(item.endMin);
    } else {
      colEnds[col] = item.endMin;
    }
    cluster.push({ id: item.id, col });
    clusterEnd = Math.max(clusterEnd, item.endMin);
  }
  if (cluster.length > 0) flush();
  return result;
}

export interface SpanItem {
  id: string;
  startIdx: number;
  endIdx: number;
}

/** Lane per span so spans in one row never overlap; longer spans claim upper lanes first. */
export function layoutSpans(items: SpanItem[]): Map<string, number> {
  const sorted = [...items].sort((a, b) => a.startIdx - b.startIdx || b.endIdx - b.startIdx - (a.endIdx - a.startIdx));
  const laneEnds: number[] = [];
  const result = new Map<string, number>();
  for (const it of sorted) {
    let lane = laneEnds.findIndex((end) => end < it.startIdx);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(it.endIdx);
    } else {
      laneEnds[lane] = it.endIdx;
    }
    result.set(it.id, lane);
  }
  return result;
}
