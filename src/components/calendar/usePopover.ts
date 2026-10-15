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

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    }
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
    };
  }, [onClose]);

  return { ref, pos };
}
