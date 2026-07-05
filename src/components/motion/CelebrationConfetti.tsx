// One-shot confetti burst. Mounted only when `trigger` changes — there's no
// always-on animation. Uses absolutely-positioned colored dots launched in
// random directions, animated with motion/react.
//
// Respects prefers-reduced-motion (renders nothing).

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";

interface CelebrationConfettiProps {
  /** Increment this number to fire a new burst. */
  trigger: number;
  /** Number of particles. Default 30. */
  count?: number;
  /** Override the default Revolut palette. */
  colors?: string[];
  /** Origin point relative to parent (0..1). Default center. */
  originX?: number;
  originY?: number;
}

const DEFAULT_COLORS = ["#3b82f6", "#8b5cf6", "#ec4899", "#f59e0b", "#10b981", "#06b6d4"];

interface Particle {
  id: number;
  color: string;
  angle: number;
  distance: number;
  rotation: number;
}

export function CelebrationConfetti({
  trigger,
  count = 30,
  colors = DEFAULT_COLORS,
  originX = 0.5,
  originY = 0.5,
}: CelebrationConfettiProps) {
  const reduce = useReducedMotion();
  const [particles, setParticles] = useState<Particle[]>([]);

  useEffect(() => {
    if (reduce || trigger === 0) {
      setParticles([]);
      return;
    }
    const next: Particle[] = Array.from({ length: count }, (_, i) => ({
      id: trigger * 1000 + i,
      color: colors[i % colors.length],
      angle: Math.random() * Math.PI * 2,
      distance: 80 + Math.random() * 160,
      rotation: (Math.random() - 0.5) * 720,
    }));
    setParticles(next);
    const timeout = setTimeout(() => setParticles([]), 1400);
    return () => clearTimeout(timeout);
  }, [trigger, count, colors, reduce]);

  if (reduce || particles.length === 0) return null;

  return (
    <div
      className="absolute pointer-events-none"
      style={{
        left: `${originX * 100}%`,
        top: `${originY * 100}%`,
        width: 0,
        height: 0,
        zIndex: 1000,
      }}
      aria-hidden
    >
      {particles.map((p) => (
        <motion.div
          key={p.id}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 1 }}
          animate={{
            x: Math.cos(p.angle) * p.distance,
            y: Math.sin(p.angle) * p.distance + 80, // gravity
            opacity: 0,
            rotate: p.rotation,
            scale: 0.4,
          }}
          transition={{ duration: 1.2, ease: [0.34, 1.56, 0.64, 1] }}
          style={{
            position: "absolute",
            width: 8,
            height: 8,
            background: p.color,
            borderRadius: 2,
          }}
        />
      ))}
    </div>
  );
}
