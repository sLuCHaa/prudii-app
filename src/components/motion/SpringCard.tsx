// A card with built-in hover-lift + press feedback + optional glow on hover.
// Use for content cards (provider tiles in wizard, command-palette suggestions,
// onboarding CTAs).
//
// Use <HoverLift> if you just need lift without card chrome.

import { motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { SPRING_SNAPPY } from "./tokens";

interface SpringCardProps {
  children: ReactNode;
  /** Lift distance in px when hovered. Default 4. */
  lift?: number;
  /** Show tap-press scale-down. Default true. */
  press?: boolean;
  /** Add an accent-coloured outer glow on hover. Default false. */
  glow?: boolean;
  className?: string;
  onClick?: () => void;
  selected?: boolean;
}

export function SpringCard({
  children,
  lift = 4,
  press = true,
  glow = false,
  className = "",
  onClick,
  selected = false,
}: SpringCardProps) {
  const reduce = useReducedMotion();

  const baseShadow = "0 1px 3px rgba(15,23,42,.04)";
  const hoverShadow = glow
    ? "0 8px 28px rgba(59,130,246,.25), 0 0 0 1px rgba(59,130,246,.15)"
    : "0 6px 20px rgba(15,23,42,.12)";

  return (
    <motion.div
      className={`rounded-xl bg-surface border ${
        selected ? "border-accent" : "border-border"
      } cursor-pointer ${className}`}
      onClick={onClick}
      initial={false}
      animate={{ boxShadow: baseShadow }}
      whileHover={reduce ? undefined : { y: -lift, boxShadow: hoverShadow }}
      whileTap={reduce || !press ? undefined : { scale: 0.98 }}
      transition={SPRING_SNAPPY}
      style={{ willChange: "transform" }}
    >
      {children}
    </motion.div>
  );
}
