import { useEffect } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Send } from "lucide-react";

// Fan of paper planes taking off — Inbox Zero, the moment the last mail is
// archived. Same motif as the send pill; classier than confetti. Fire and
// forget: mounts, flies once (~1.3s), calls onDone.
const PLANES = [
  { x: -170, y: -270, rotate: -34, delay: 0.0, size: 18 },
  { x: -80, y: -330, rotate: -16, delay: 0.07, size: 22 },
  { x: 6, y: -360, rotate: 0, delay: 0.14, size: 26 },
  { x: 95, y: -325, rotate: 15, delay: 0.05, size: 22 },
  { x: 180, y: -260, rotate: 33, delay: 0.11, size: 18 },
  { x: -28, y: -300, rotate: -7, delay: 0.2, size: 16 },
];

export function InboxZeroFlight({ onDone }: { onDone: () => void }) {
  const reduce = useReducedMotion();

  useEffect(() => {
    if (reduce) {
      onDone();
      return;
    }
    const timer = window.setTimeout(onDone, 1500);
    return () => window.clearTimeout(timer);
  }, [reduce, onDone]);

  if (reduce) return null;

  return (
    <div aria-hidden className="absolute inset-0 z-20 pointer-events-none overflow-hidden">
      {/* Accent glow blooming under the take-off point */}
      <motion.div
        className="absolute left-1/2 bottom-[26%] w-64 h-64 -translate-x-1/2 rounded-full"
        style={{ background: "radial-gradient(circle, var(--c-accent) 0%, transparent 68%)" }}
        initial={{ opacity: 0, scale: 0.4 }}
        animate={{ opacity: [0, 0.32, 0], scale: [0.4, 1.5, 1.9] }}
        transition={{ duration: 1.2, ease: "easeOut" }}
      />
      {PLANES.map((plane, i) => (
        <motion.div
          key={i}
          className="absolute left-1/2 bottom-[28%] text-accent"
          initial={{ x: 0, y: 10, rotate: plane.rotate - 10, scale: 0.8, opacity: 0 }}
          animate={{
            x: plane.x,
            y: plane.y,
            rotate: plane.rotate,
            scale: 0.5,
            opacity: [0, 1, 1, 0],
          }}
          transition={{ duration: 1.05, delay: plane.delay, ease: [0.2, 0.65, 0.3, 1] }}
        >
          <Send style={{ width: plane.size, height: plane.size, transform: "rotate(-24deg)" }} />
        </motion.div>
      ))}
    </div>
  );
}
