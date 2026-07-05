// Toast container with spring stack choreography: newest toast springs in from
// the right; older toasts age in place by scaling to 0.96 and losing saturation.
// Up to maxVisible toasts shown; older ones drop out the bottom.
//
// Variant + content rendering is left to the consumer — this primitive owns
// the stack layout, entry/exit animation, and the signature top gradient bar.

import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import type { ReactNode } from "react";
import { SPRING_BOUNCY } from "./tokens";

export type ToastVariant = "info" | "success" | "warning" | "error" | "undo";

export interface StackedToastItem {
  id: string;
  variant: ToastVariant;
  render: () => ReactNode;
  /** Allow swipe-to-dismiss. Default true. */
  dismissible?: boolean;
  onDismiss?: () => void;
}

interface StackedToastProps {
  toasts: StackedToastItem[];
  /** Anchor: where the stack lives. Default bottom-right. */
  position?: "bottom-right" | "bottom-center";
  /** Max simultaneously rendered toasts. Default 3. */
  maxVisible?: number;
}

const VARIANT_BAR: Record<ToastVariant, string> = {
  info:    "linear-gradient(90deg, #3b82f6, #8b5cf6)",
  success: "linear-gradient(90deg, #10b981, #3b82f6)",
  warning: "linear-gradient(90deg, #f59e0b, #ef4444)",
  error:   "linear-gradient(90deg, #ef4444, #f43f5e)",
  undo:    "linear-gradient(90deg, #3b82f6, #06b6d4)",
};

export function StackedToast({
  toasts,
  position = "bottom-right",
  maxVisible = 3,
}: StackedToastProps) {
  const reduce = useReducedMotion();
  const visible = toasts.slice(-maxVisible);

  const posClass =
    position === "bottom-center"
      ? "bottom-6 left-1/2 -translate-x-1/2"
      : "bottom-6 right-6";

  return (
    <div className={`fixed ${posClass} z-100 flex flex-col gap-2 pointer-events-none`}>
      <AnimatePresence initial={false}>
        {visible.map((toast, idx) => {
          const reverseIdx = visible.length - 1 - idx; // 0 = newest
          const scale = 1 - reverseIdx * 0.04;
          const saturation = 1 - reverseIdx * 0.2;

          return (
            <motion.div
              key={toast.id}
              className="pointer-events-auto relative overflow-hidden rounded-xl bg-surface border border-border shadow-lg min-w-[280px] max-w-[400px]"
              initial={reduce ? { opacity: 0 } : { opacity: 0, x: 40, scale: 0.9 }}
              animate={
                reduce
                  ? { opacity: 1 }
                  : { opacity: 1, x: 0, scale, filter: `saturate(${saturation})` }
              }
              exit={reduce ? { opacity: 0 } : { opacity: 0, x: 60, scale: 0.85, transition: { duration: 0.2 } }}
              transition={SPRING_BOUNCY}
              drag={!reduce && toast.dismissible !== false ? "x" : false}
              dragConstraints={{ left: 0, right: 0 }}
              dragElastic={0.6}
              onDragEnd={(_, info) => {
                if (Math.abs(info.offset.x) > 100 || Math.abs(info.velocity.x) > 500) {
                  toast.onDismiss?.();
                }
              }}
              style={{ willChange: "transform" }}
            >
              <div
                aria-hidden
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  right: 0,
                  height: 2,
                  background: VARIANT_BAR[toast.variant],
                }}
              />
              {toast.render()}
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}
