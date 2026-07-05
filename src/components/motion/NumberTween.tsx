// Counter that animates from `from` to `to` over `duration` ms using rAF.
// Format hook lets callers add separators ("2,847") or units.
//
// Respects prefers-reduced-motion (snaps to `to` instantly).

import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "motion/react";
import { DURATION_COUNT_MS } from "./tokens";

interface NumberTweenProps {
  from?: number;
  to: number;
  /** Duration in ms. Default DURATION_COUNT_MS (600). */
  duration?: number;
  /** Format the displayed number. Default toLocaleString. */
  format?: (n: number) => string;
  className?: string;
}

function defaultFormat(n: number) {
  return Math.round(n).toLocaleString();
}

// easeOutCubic — feels confident, decelerates naturally
function easeOut(t: number) {
  return 1 - Math.pow(1 - t, 3);
}

export function NumberTween({
  from = 0,
  to,
  duration = DURATION_COUNT_MS,
  format = defaultFormat,
  className,
}: NumberTweenProps) {
  const reduce = useReducedMotion();
  const [value, setValue] = useState(reduce ? to : from);
  const startRef = useRef<number | null>(null);
  const fromRef = useRef(from);
  const toRef = useRef(to);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (reduce) {
      setValue(to);
      return;
    }
    fromRef.current = value; // tween from current displayed value, not original `from`
    toRef.current = to;
    startRef.current = null;

    function tick(ts: number) {
      if (startRef.current === null) startRef.current = ts;
      const elapsed = ts - startRef.current;
      const t = Math.min(1, elapsed / duration);
      const eased = easeOut(t);
      setValue(fromRef.current + (toRef.current - fromRef.current) * eased);
      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // intentionally omit `value` from deps — we re-read it via fromRef
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [to, duration, reduce]);

  return <span className={className}>{format(value)}</span>;
}
