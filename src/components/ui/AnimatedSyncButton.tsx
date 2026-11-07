import { useRef, useEffect } from "react";
import gsap from "gsap";
import { prefersReducedMotion } from "../motion/tokens";

interface AnimatedSyncButtonProps {
  isSyncing: boolean;
  onClick: (e: React.MouseEvent) => void;
  size?: number;
  alwaysVisible?: boolean;
  disabled?: boolean;
}

// Bridges the moment between "request sent" and "first progress event", so
// the arrows don't stop and restart in between.
const STOP_GRACE_MS = 180;

export function AnimatedSyncButton({ isSyncing, onClick, size = 14, alwaysVisible = false, disabled = false }: AnimatedSyncButtonProps) {
  const containerRef = useRef<HTMLButtonElement>(null);
  const arrowsRef = useRef<SVGGElement>(null);
  const spinRef = useRef<gsap.core.Tween | null>(null);
  const stopTimer = useRef(0);

  useEffect(() => {
    const arrows = arrowsRef.current;
    if (!arrows) return;
    window.clearTimeout(stopTimer.current);

    if (isSyncing) {
      if (spinRef.current) return;
      gsap.killTweensOf(arrows);
      // The rotation stays even under reduced motion — it IS the loading
      // indicator; only the run-up is skipped.
      const spin = gsap.to(arrows, { rotation: "+=360", duration: 0.95, ease: "none", repeat: -1, transformOrigin: "center center" });
      if (!prefersReducedMotion()) {
        spin.timeScale(0);
        gsap.to(spin, { timeScale: 1, duration: 0.35, ease: "power1.in" });
      }
      spinRef.current = spin;
      return;
    }

    if (!spinRef.current) return;
    stopTimer.current = window.setTimeout(() => {
      const spin = spinRef.current;
      spinRef.current = null;
      if (!spin) return;
      spin.kill();
      // Run out to the next full turn instead of snapping back to 0°.
      const angle = Number(gsap.getProperty(arrows, "rotation")) || 0;
      let target = Math.ceil(angle / 360) * 360;
      if (target - angle < 140) target += 360;
      gsap.to(arrows, {
        rotation: target,
        duration: prefersReducedMotion() ? 0 : 0.75,
        ease: "power3.out",
        onComplete: () => { gsap.set(arrows, { rotation: 0 }); },
      });
    }, STOP_GRACE_MS);
  }, [isSyncing]);

  useEffect(() => () => {
    window.clearTimeout(stopTimer.current);
    spinRef.current?.kill();
    if (arrowsRef.current) gsap.killTweensOf(arrowsRef.current);
  }, []);

  function handleMouseEnter() {
    if (isSyncing || spinRef.current || disabled || !arrowsRef.current) return;
    gsap.to(arrowsRef.current, {
      rotation: 180,
      duration: 0.4,
      ease: "back.out(1.5)",
    });
  }

  function handleMouseLeave() {
    if (isSyncing || spinRef.current || disabled || !arrowsRef.current) return;
    gsap.to(arrowsRef.current, {
      rotation: 0,
      duration: 0.3,
      ease: "power2.out",
    });
  }

  function handleClick(e: React.MouseEvent) {
    if (isSyncing || disabled) return;

    if (containerRef.current) {
      gsap.timeline()
        .to(containerRef.current, { scale: 0.8, duration: 0.1 })
        .to(containerRef.current, { scale: 1, duration: 0.3, ease: "elastic.out(1, 0.5)" });
    }

    onClick(e);
  }

  return (
    <button
      ref={containerRef}
      onClick={handleClick}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      disabled={isSyncing || disabled}
      className={`relative p-1 rounded-md transition-colors shrink-0 ${
        disabled ? "text-text-tertiary opacity-30 cursor-default" :
        isSyncing ? "text-accent" :
        alwaysVisible ? "text-text-tertiary hover:bg-hover" :
        "text-text-tertiary opacity-0 group-hover:opacity-100 hover:bg-hover"
      }`}
      title={isSyncing ? "Syncing..." : "Sync"}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
        <g ref={arrowsRef} style={{ transformOrigin: "12px 12px" }}>
          <path
            d="M21 12a9 9 0 1 1-2.2-5.9"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
          <path
            d="M21 4v5h-5"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </g>
      </svg>
    </button>
  );
}
