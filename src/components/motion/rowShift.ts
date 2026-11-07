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

// Mail arriving on top: a longer, softer glide, and the new row slides in
// with a short accent wash so the eye finds it.
const ARRIVE_MS = 420;
const ARRIVE_EASE = "cubic-bezier(0.2, 0.8, 0.2, 1)";
const WASH_MS = 2600;
// A refresh that brings a whole batch is not "a new mail" — those just fade in.
const MAX_WASHED = 5;

/**
 * New rows with an old row still below them: mail that arrived, not a page
 * loaded under the list (that lands below every old row). A date header that
 * was already there may sit above the new mail.
 */
export function arrivedOnTop(before: Map<string, number>, after: RowTop[]): string[] {
  const kept = after.filter((r) => before.has(r.key)).map((r) => r.top);
  if (kept.length === 0) return [];
  const lastKept = Math.max(...kept);
  return after.filter((r) => !before.has(r.key) && r.top < lastKept).map((r) => r.key);
}

function washRow(row: HTMLElement): void {
  const body = row.querySelector<HTMLElement>(".mail-row-body") ?? row;
  const accent = getComputedStyle(body).getPropertyValue("--c-accent").trim();
  if (!accent) return;
  const rest = getComputedStyle(body).backgroundColor;
  const tint = `color-mix(in srgb, ${accent} 16%, ${rest})`;
  body.animate?.(
    [
      { backgroundColor: tint, boxShadow: `inset 3px 0 0 ${accent}` },
      { backgroundColor: tint, boxShadow: `inset 3px 0 0 ${accent}`, offset: 0.3 },
      { backgroundColor: rest, boxShadow: "inset 3px 0 0 transparent" },
    ],
    { duration: WASH_MS, easing: "ease-out" },
  );
}

export function playRowShifts(list: HTMLElement, before: Map<string, number>, fadeNew = false): void {
  const { els, tops } = rowTops(list);
  const shifts = rowShifts(before, tops);
  // A shift past a whole viewport is a different list, not a closing gap.
  if (shifts.some((s) => Math.abs(s.delta) > list.clientHeight)) return;
  const arrived = fadeNew ? new Set(arrivedOnTop(before, tops)) : new Set<string>();
  const timing = arrived.size > 0 ? { duration: ARRIVE_MS, easing: ARRIVE_EASE } : { duration: SHIFT_MS, easing: SHIFT_EASE };
  for (const { key, delta } of shifts) {
    els.get(key)?.animate?.([{ translate: `0 ${delta}px` }, { translate: "0 0" }], timing);
  }
  if (!fadeNew) return;
  for (const { key } of tops) {
    if (before.has(key)) continue;
    const el = els.get(key);
    if (!el) continue;
    if (arrived.has(key)) {
      el.animate?.([{ opacity: 0, translate: "0 -8px" }, { opacity: 1, translate: "0 0" }], { duration: ARRIVE_MS, easing: ARRIVE_EASE });
      if (arrived.size <= MAX_WASHED) washRow(el);
    } else {
      el.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: SHIFT_MS, easing: SHIFT_EASE });
    }
  }
}
