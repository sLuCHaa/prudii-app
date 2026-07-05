// Spring + transition constants for motion primitives. These are consumed
// by motion/react components (not CSS), so they live as TS objects.
// Keep this file tiny — semantic names only, no per-component variants.

import type { Transition } from "motion/react";

/** Buttons, hover, toggles — fast & decisive. */
export const SPRING_SNAPPY: Transition = {
  type: "spring",
  stiffness: 400,
  damping: 30,
};

/** Cards, panels, modal entries — natural bounce. */
export const SPRING_BOUNCY: Transition = {
  type: "spring",
  stiffness: 300,
  damping: 18,
};

/** Wow-moments (confetti, success morph) — visible overshoot. */
export const SPRING_CELEBRATE: Transition = {
  type: "spring",
  stiffness: 200,
  damping: 12,
};

/** Cubic-bezier for one-off keyframe sequences. */
export const EASE_OVERSHOOT = [0.34, 1.56, 0.64, 1] as const;

/** Default duration for NumberTween animations. */
export const DURATION_COUNT_MS = 600;

/** Convenience: instant transition for reduced-motion fallback. */
export const TRANSITION_INSTANT: Transition = { duration: 0 };

/** Crossfades — loading skeleton fading out to reveal content. (motion/react) */
export const FADE_FAST: Transition = {
  duration: 0.18,
  ease: "easeOut",
};

/** Canonical "settle-in" entrance for list rows and revealed content.
 *  Plain numbers — consumed by GSAP tweens, not motion/react. */
export const ENTRANCE = {
  y: 8,
  duration: 0.22,
  stagger: 0.025,
  ease: "power2.out",
} as const;

/** GSAP-side reduced-motion check, mirroring motion/react's useReducedMotion()
 *  for the imperative animation paths. Safe outside the browser. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
