// Lets virtualized rows glide into the gap a removal leaves (FLIP). Animates the
// individual `translate` property, so the virtualizer's own `transform` stays intact.

const SHIFT_MS = 220;
// A gentle start: opening the next mail often drops a frame right as the glide begins.
const SHIFT_EASE = "ease-out";

export interface RowTop {
  key: string;
  top: number;
}

/** Rows new to the DOM borrow the shift of the row above them. */
export function rowShifts(before: Map<string, number>, after: RowTop[]): { key: string; delta: number }[] {
  let carry = 0;
  return [...after]
    .sort((a, b) => a.top - b.top)
    .map(({ key, top }) => {
      const prev = before.get(key);
      const delta = prev === undefined ? carry : prev - top;
      carry = delta;
      return { key, delta };
    })
    .filter((s) => Math.abs(s.delta) >= 0.5);
}

function rowTops(list: HTMLElement): { els: Map<string, HTMLElement>; tops: RowTop[] } {
  const els = new Map<string, HTMLElement>();
  const tops: RowTop[] = [];
  list.querySelectorAll<HTMLElement>("[data-row-key]").forEach((el) => {
    const key = el.dataset.rowKey!;
    els.set(key, el);
    tops.push({ key, top: el.getBoundingClientRect().top });
  });
  return { els, tops };
}

export function snapshotRows(list: HTMLElement): Map<string, number> {
  return new Map(rowTops(list).tops.map((r) => [r.key, r.top]));
}

export function playRowShifts(list: HTMLElement, before: Map<string, number>, fadeNew = false): void {
  const { els, tops } = rowTops(list);
  const shifts = rowShifts(before, tops);
  // A shift past a whole viewport is a different list, not a closing gap.
  if (shifts.some((s) => Math.abs(s.delta) > list.clientHeight)) return;
  for (const { key, delta } of shifts) {
    els.get(key)?.animate?.([{ translate: `0 ${delta}px` }, { translate: "0 0" }], { duration: SHIFT_MS, easing: SHIFT_EASE });
  }
  if (!fadeNew) return;
  for (const { key } of tops) {
    if (!before.has(key)) els.get(key)?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: SHIFT_MS, easing: SHIFT_EASE });
  }
}
