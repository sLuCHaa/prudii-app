import { motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { DaylightSky, useAtmosphereLine } from "../motion/DaylightSky";
import { SPRING_BOUNCY } from "../motion/tokens";

// Ruled lines of the pad, drawn in order. Widths differ so it reads as writing
// rather than as a placeholder block.
const LINES = [
  { y: 26, width: 26 },
  { y: 34, width: 26 },
  { y: 42, width: 16 },
];

/**
 * The tasks view before anything has been written down.
 *
 * Deliberately quieter than the all-done board, which earns its confetti: an
 * empty list is a starting point, not an achievement. It borrows the inbox-zero
 * treatment — tinted sky, a time-of-day line — so the two empty moments in the
 * app read as the same hand.
 */
export function NoTasksState() {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const line = useAtmosphereLine("noTasks");

  const draw = (i: number) =>
    reduce
      ? { duration: 0 }
      : { duration: 0.45, delay: 0.35 + i * 0.18, ease: "easeOut" as const };

  return (
    <div className="relative flex-1 min-h-[320px] overflow-hidden">
      <DaylightSky />
      <div className="relative z-10 flex h-full flex-col items-center justify-center px-6 py-16 text-center">
        <motion.div
          initial={reduce ? false : { scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={SPRING_BOUNCY}
          className="mb-5 text-text-tertiary"
        >
          <svg viewBox="0 0 64 64" className="h-16 w-16" fill="none" aria-hidden>
            {/* Board and clip stay static; only the ruled lines are written. */}
            <rect x="12" y="10" width="40" height="46" rx="6" stroke="currentColor" strokeWidth="2.5" />
            <path
              d="M25 10a3 3 0 0 1 3-3h8a3 3 0 0 1 3 3v3H25z"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            {LINES.map((l, i) => (
              <motion.line
                key={l.y}
                x1="21"
                y1={l.y}
                x2={21 + l.width}
                y2={l.y}
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                initial={reduce ? false : { pathLength: 0, opacity: 0 }}
                animate={{ pathLength: 1, opacity: 1 }}
                transition={draw(i)}
              />
            ))}
          </svg>
        </motion.div>

        <h2 className="font-heading text-xl font-bold text-text">{t("tasks.empty")}</h2>
        {/* The locale may carry no pool for this hour; the static line covers it. */}
        <p className="mt-2 max-w-xs text-sm leading-relaxed text-text-secondary">
          {line ?? t("tasks.emptyDesc")}
        </p>
      </div>
    </div>
  );
}
