// Overlays `skeleton` on top of `children` while `loading` is true, then fades
// the skeleton out to *reveal* the already-mounted content — a morph with no
// gap. The skeleton only appears once loading has persisted past a short delay,
// so fast/cached loads never flash a skeleton. Respects prefers-reduced-motion.

import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { FADE_FAST } from "./tokens";

const FLASH_GUARD_MS = 120;

interface LoadingCrossfadeProps {
  loading: boolean;
  skeleton: ReactNode;
  children: ReactNode;
  className?: string;
}

export function LoadingCrossfade({ loading, skeleton, children, className }: LoadingCrossfadeProps) {
  const reduce = useReducedMotion();

  // Show the skeleton only once `loading` has persisted past the flash guard.
  const [showSkeleton, setShowSkeleton] = useState(loading);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!loading) {
      setShowSkeleton(false);
      return;
    }
    if (reduce) {
      setShowSkeleton(true);
      return;
    }
    timerRef.current = setTimeout(() => setShowSkeleton(true), FLASH_GUARD_MS);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [loading, reduce]);

  if (reduce) {
    return <div className={className}>{loading ? skeleton : children}</div>;
  }

  return (
    <div className={`relative ${className ?? ""}`}>
      {children}
      <AnimatePresence>
        {showSkeleton && (
          <motion.div
            key="skeleton"
            className="absolute inset-0 pointer-events-none bg-bg"
            initial={{ opacity: 1 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={FADE_FAST}
          >
            {skeleton}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
