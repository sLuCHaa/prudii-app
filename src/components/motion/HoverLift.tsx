// Wraps a child and gives it a subtle hover-lift + tap-press effect using
// GPU-friendly transforms only. Intensity scales the lift distance and
// shadow strength.
//
// Respects prefers-reduced-motion via useReducedMotion (no transform on hover).

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { SPRING_SNAPPY } from "./tokens";

interface HoverLiftProps {
  children: ReactNode;
  /** 1 = subtle (list rows), 2 = medium (buttons), 3 = strong (hero cards). */
  intensity?: 1 | 2 | 3;
  className?: string;
  onClick?: () => void;
}

const LIFT_BY_INTENSITY = { 1: -2, 2: -4, 3: -8 };
const SHADOW_BY_INTENSITY = {
  1: "0 2px 8px rgba(15,23,42,.08)",
  2: "0 6px 20px rgba(15,23,42,.12)",
  3: "0 14px 40px rgba(15,23,42,.18)",
};

export function HoverLift({ children, intensity = 1, className, onClick }: HoverLiftProps) {
  const reduce = useReducedMotion();
  const lift = LIFT_BY_INTENSITY[intensity];
  const shadow = SHADOW_BY_INTENSITY[intensity];

  if (reduce) {
    return (
      <div className={className} onClick={onClick}>
        {children}
      </div>
    );
  }

  return (
    <motion.div
      className={className}
      onClick={onClick}
      whileHover={{ y: lift, boxShadow: shadow }}
      whileTap={{ y: lift / 2, transition: { duration: 0.08 } }}
      transition={SPRING_SNAPPY}
      style={{ willChange: "transform" }}
    >
      {children}
    </motion.div>
  );
}
