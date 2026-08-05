import { useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  label: string;
  /** Preferred side; flips when there is no room. */
  side?: "top" | "bottom";
  delayMs?: number;
  children: React.ReactNode;
}

/**
 * Styled replacement for native `title=` tooltips: themed, dark-mode aware,
 * consistent delay. Wraps its child in an inline-flex span; keep aria-labels
 * on the child for screen readers.
 */
export function Tooltip({ label, side = "bottom", delayMs = 450, children }: TooltipProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<number | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number; side: "top" | "bottom" } | null>(null);

  const show = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const wantTop = side === "top" ? r.top > 40 : r.bottom > window.innerHeight - 40;
      setPos({
        left: Math.min(Math.max(8, r.left + r.width / 2), window.innerWidth - 8),
        top: wantTop ? r.top - 6 : r.bottom + 6,
        side: wantTop ? "top" : "bottom",
      });
    }, delayMs);
  }, [delayMs, side]);

  const hide = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    setPos(null);
  }, []);

  return (
    <span
      ref={wrapRef}
      className="inline-flex"
      onMouseEnter={show}
      onMouseLeave={hide}
      onMouseDown={hide}
      onFocus={show}
      onBlur={hide}
    >
      {children}
      {pos &&
        createPortal(
          <div
            role="tooltip"
            className="tooltip-bubble"
            style={{
              left: pos.left,
              top: pos.top,
              transform: `translate(-50%, ${pos.side === "top" ? "-100%" : "0"})`,
            }}
          >
            {label}
          </div>,
          document.body
        )}
    </span>
  );
}
