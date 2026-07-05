import { useRef, useEffect } from "react";
import gsap from "gsap";

interface AnimatedSyncButtonProps {
  isSyncing: boolean;
  onClick: (e: React.MouseEvent) => void;
  size?: number;
  alwaysVisible?: boolean;
  disabled?: boolean;
}

export function AnimatedSyncButton({ isSyncing, onClick, size = 14, alwaysVisible = false, disabled = false }: AnimatedSyncButtonProps) {
  const containerRef = useRef<HTMLButtonElement>(null);
  const arrowsRef = useRef<SVGGElement>(null);
  const pulseRef = useRef<SVGCircleElement>(null);

  useEffect(() => {
    if (!arrowsRef.current) return;

    if (isSyncing) {
      gsap.to(arrowsRef.current, {
        rotation: 360,
        duration: 1,
        ease: "none",
        repeat: -1,
        transformOrigin: "center center",
      });

      if (pulseRef.current) {
        gsap.to(pulseRef.current, {
          scale: 1.5,
          opacity: 0,
          duration: 1,
          ease: "power2.out",
          repeat: -1,
        });
      }
    } else {
      gsap.killTweensOf(arrowsRef.current);
      gsap.killTweensOf(pulseRef.current);
      gsap.set(arrowsRef.current, { rotation: 0 });
      gsap.set(pulseRef.current, { scale: 1, opacity: 0 });
    }

    return () => {
      gsap.killTweensOf(arrowsRef.current);
      gsap.killTweensOf(pulseRef.current);
    };
  }, [isSyncing]);

  function handleMouseEnter() {
    if (isSyncing || disabled || !arrowsRef.current) return;
    gsap.to(arrowsRef.current, {
      rotation: 180,
      duration: 0.4,
      ease: "back.out(1.5)",
    });
  }

  function handleMouseLeave() {
    if (isSyncing || disabled || !arrowsRef.current) return;
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
        <circle
          ref={pulseRef}
          cx="12"
          cy="12"
          r="10"
          fill="currentColor"
          opacity="0"
          style={{ transformOrigin: "12px 12px" }}
        />

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
