// Live-status dot that emits N concentric pulse rings. Used for sync activity,
// new-mail indicators, and error markers in the sidebar.
//
// Color accepts any CSS color (use semantic tokens like var(--c-accent)).

import { motion, useReducedMotion } from "motion/react";

interface PulseDotProps {
  /** CSS color (default: accent). */
  color?: string;
  /** Dot diameter in px. Default 8. */
  size?: number;
  /** Number of concentric pulse rings. Default 2. */
  ringCount?: number;
  className?: string;
}

export function PulseDot({
  color = "var(--c-accent)",
  size = 8,
  ringCount = 2,
  className = "",
}: PulseDotProps) {
  const reduce = useReducedMotion();
  const rings = Array.from({ length: ringCount }, (_, i) => i);

  return (
    <span
      className={`relative inline-flex items-center justify-center ${className}`}
      style={{ width: size * 3, height: size * 3 }}
      aria-hidden
    >
      {!reduce &&
        rings.map((i) => (
          <motion.span
            key={i}
            className="absolute rounded-full"
            style={{
              width: size,
              height: size,
              background: color,
              opacity: 0.4,
            }}
            initial={{ scale: 1, opacity: 0.5 }}
            animate={{ scale: 3, opacity: 0 }}
            transition={{
              duration: 1.6,
              repeat: Infinity,
              delay: (i * 1.6) / ringCount,
              ease: "easeOut",
            }}
          />
        ))}
      <span
        className="relative rounded-full"
        style={{ width: size, height: size, background: color }}
      />
    </span>
  );
}
