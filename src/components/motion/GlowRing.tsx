// Dual-mode primitive:
//   - Default: a soft glowing outline around its child (focus/status indicator).
//   - With `progress` prop: an SVG arc countdown (0..1) used by UndoToast.

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";

interface GlowRingWrapperProps {
  /** Wrap a child element with a glow ring (default mode). */
  children: ReactNode;
  active?: boolean;
  /** 1-3 — controls glow blur radius. */
  intensity?: 1 | 2 | 3;
  className?: string;
}

interface GlowRingProgressProps {
  /** Render as an SVG progress arc (0..1) — no children. */
  progress: number;
  color?: string;
  size?: number;
  strokeWidth?: number;
  children?: ReactNode;
}

type Props = GlowRingWrapperProps | GlowRingProgressProps;

function isProgressMode(p: Props): p is GlowRingProgressProps {
  return typeof (p as GlowRingProgressProps).progress === "number";
}

const GLOW_BY_INTENSITY = {
  1: "0 0 0 2px rgba(59,130,246,.15), 0 0 12px rgba(59,130,246,.3)",
  2: "0 0 0 3px rgba(59,130,246,.25), 0 0 20px rgba(59,130,246,.5)",
  3: "0 0 0 4px rgba(59,130,246,.35), 0 0 32px rgba(59,130,246,.7)",
};

export function GlowRing(props: Props) {
  const reduce = useReducedMotion();

  if (isProgressMode(props)) {
    const { progress, color = "var(--c-accent)", size = 28, strokeWidth = 3, children } = props;
    const radius = (size - strokeWidth) / 2;
    const circumference = 2 * Math.PI * radius;
    const clamped = Math.max(0, Math.min(1, progress));

    return (
      <div className="relative shrink-0" style={{ width: size, height: size }}>
        <svg width={size} height={size} className="absolute inset-0 -rotate-90">
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="currentColor"
            className="text-border"
            strokeWidth={strokeWidth}
          />
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke={color}
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clamped)}
            style={{ transition: reduce ? "none" : "stroke-dashoffset 0.1s linear" }}
          />
        </svg>
        {children && (
          <span className="absolute inset-0 flex items-center justify-center">{children}</span>
        )}
      </div>
    );
  }

  const { children, active = true, intensity = 2, className = "" } = props;
  const glow = GLOW_BY_INTENSITY[intensity];

  return (
    <motion.div
      className={`rounded-xl ${className}`}
      animate={
        reduce
          ? undefined
          : {
              boxShadow: active ? glow : "0 0 0 0 transparent",
            }
      }
      transition={{ duration: 0.25, ease: "easeOut" }}
    >
      {children}
    </motion.div>
  );
}
