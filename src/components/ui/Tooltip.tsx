import { useRef, useState, useCallback, useLayoutEffect } from "react";
import { createPortal } from "react-dom";

interface TooltipProps {
  label: React.ReactNode;
  rich?: boolean;
  /** Preferred side; flips when there is no room. */
  side?: "top" | "bottom";
  delayMs?: number;
  className?: string;
  children: React.ReactNode;
}

const EDGE = 8;
const WARM_MS = 400;

// Shared by every tooltip: once one has shown, its neighbours open at once.
let warmUntil = 0;

export function tooltipDelay(now: number, warmEnd: number, delayMs: number): number {
  return now < warmEnd ? 0 : delayMs;
}

/** Bubble center that keeps a bubble of `width` inside the viewport. */
export function clampCenter(center: number, width: number, viewport: number): number {
  const min = EDGE + width / 2;
  const max = viewport - EDGE - width / 2;
  return max < min ? viewport / 2 : Math.min(Math.max(center, min), max);
}

/**
 * Styled replacement for native `title=` tooltips: themed, dark-mode aware,
 * consistent delay. Wraps its child in an inline-flex span; keep aria-labels
 * on the child for screen readers.
 */
export function Tooltip({ label, rich, side = "bottom", delayMs = 450, className, children }: TooltipProps) {
  const wrapRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const timerRef = useRef<number | null>(null);
  const shownRef = useRef(false);
  const [pos, setPos] = useState<{ left: number; top: number; side: "top" | "bottom" } | null>(null);

  const show = useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      const wantTop = side === "top" ? r.top > 40 : r.bottom > window.innerHeight - 40;
      shownRef.current = true;
      setPos({
        left: r.left + r.width / 2,
        top: wantTop ? r.top - 6 : r.bottom + 6,
        side: wantTop ? "top" : "bottom",
      });
    }, tooltipDelay(Date.now(), warmUntil, delayMs));
  }, [delayMs, side]);

  const hide = useCallback((warm: boolean) => {
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    if (warm && shownRef.current) warmUntil = Date.now() + WARM_MS;
    shownRef.current = false;
    setPos(null);
  }, []);

  useLayoutEffect(() => {
    const bubble = bubbleRef.current;
    if (!pos || !bubble) return;
    bubble.style.left = `${clampCenter(pos.left, bubble.offsetWidth, window.innerWidth)}px`;
  }, [pos]);

  return (
    <span
      ref={wrapRef}
      className={className ? `inline-flex ${className}` : "inline-flex"}
      onMouseEnter={show}
      onMouseLeave={() => hide(true)}
      // Capture: buttons that stop mousedown propagation must still close it.
      onMouseDownCapture={() => hide(false)}
      onFocus={show}
      onBlur={() => hide(false)}
    >
      {children}
      {pos &&
        createPortal(
          <div
            ref={bubbleRef}
            role="tooltip"
            className={rich ? "tooltip-bubble tooltip-bubble-rich" : "tooltip-bubble"}
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
