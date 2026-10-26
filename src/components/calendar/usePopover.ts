import { useEffect, useLayoutEffect, useRef, useState } from "react";

/** Fixed-position panel beside `anchor`, kept inside the viewport; Escape or an outside click closes it. */
export function usePopover(anchor: DOMRect, onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.right + 8, top: anchor.top });

  // No dependency list: the panel grows once its detail query resolves.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    let left = anchor.right + 8;
    if (left + w > window.innerWidth - 8) left = Math.max(8, anchor.left - w - 8);
    const top = Math.max(8, Math.min(anchor.top, window.innerHeight - h - 8));
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  });

  // Non-modal popover: move focus in on open, hand it back on close.
  useEffect(() => {
    const panel = ref.current;
    const previous = document.activeElement as HTMLElement | null;
    const first = panel?.querySelector<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])');
    // A link inside the clamped description would otherwise scroll the clamp box to itself.
    (first ?? panel)?.focus({ preventScroll: true });
    return () => {
      const active = document.activeElement;
      if (
        previous?.isConnected &&
        (!active || active === document.body || (panel?.contains(active) ?? false))
      ) {
        previous.focus();
      }
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    }
    function onDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("keydown", onKey, true);
    // Not mousedown: the time grid cancels pointerdown to drag-create, which suppresses it.
    document.addEventListener("pointerdown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("pointerdown", onDown, true);
    };
  }, [onClose]);

  return { ref, pos };
}
