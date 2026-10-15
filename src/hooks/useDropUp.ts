import { useLayoutEffect, useState, type RefObject } from "react";

function visibleBounds(el: Element): { top: number; bottom: number } {
  let top = 0;
  let bottom = window.innerHeight;
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY !== "auto" && overflowY !== "scroll") continue;
    const r = p.getBoundingClientRect();
    top = Math.max(top, r.top);
    bottom = Math.min(bottom, r.bottom);
  }
  return { top, bottom };
}

// A layout effect measures before paint, so the popup never flashes on the wrong side.
export function useDropUp(
  open: boolean,
  anchorRef: RefObject<HTMLElement | null>,
  popupRef: RefObject<HTMLElement | null>,
): boolean {
  const [up, setUp] = useState(false);
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const popup = popupRef.current;
    if (!open || !anchor || !popup) return;
    const a = anchor.getBoundingClientRect();
    const { top, bottom } = visibleBounds(anchor);
    const below = bottom - a.bottom;
    setUp(below < popup.getBoundingClientRect().height + 8 && a.top - top > below);
  }, [open, anchorRef, popupRef]);
  return up;
}
