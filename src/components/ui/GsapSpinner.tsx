import { useEffect, useRef } from "react";
import gsap from "gsap";

interface GsapSpinnerProps {
  size?: number;
  color?: string;
  className?: string;
}

export function GsapSpinner({ size = 24, color = "currentColor", className = "" }: GsapSpinnerProps) {
  const containerRef = useRef<SVGSVGElement>(null);
  const dotsRef = useRef<SVGCircleElement[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;

    const dots = dotsRef.current;
    const tl = gsap.timeline({ repeat: -1 });

    tl.to(dots, {
      scale: 1.5,
      opacity: 1,
      duration: 0.4,
      ease: "power2.out",
      stagger: {
        each: 0.1,
        repeat: -1,
        yoyo: true,
      },
    });

    gsap.to(containerRef.current, {
      rotation: 360,
      duration: 2,
      ease: "none",
      repeat: -1,
    });

    return () => {
      tl.kill();
      gsap.killTweensOf(containerRef.current);
    };
  }, []);

  const dotCount = 8;
  const radius = size * 0.35;

  return (
    <svg
      ref={containerRef}
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className={className}
    >
      {Array.from({ length: dotCount }).map((_, i) => {
        const angle = (i * 360) / dotCount;
        const x = size / 2 + radius * Math.cos((angle * Math.PI) / 180);
        const y = size / 2 + radius * Math.sin((angle * Math.PI) / 180);
        return (
          <circle
            key={i}
            ref={(el) => {
              if (el) dotsRef.current[i] = el;
            }}
            cx={x}
            cy={y}
            r={size * 0.06}
            fill={color}
            opacity={0.3 + (i / dotCount) * 0.7}
          />
        );
      })}
    </svg>
  );
}

export function GsapPulseSpinner({ size = 24, color = "currentColor", className = "" }: GsapSpinnerProps) {
  const ring1Ref = useRef<SVGCircleElement>(null);
  const ring2Ref = useRef<SVGCircleElement>(null);
  const ring3Ref = useRef<SVGCircleElement>(null);

  useEffect(() => {
    const rings = [ring1Ref.current, ring2Ref.current, ring3Ref.current].filter(Boolean);

    rings.forEach((ring, i) => {
      gsap.fromTo(
        ring,
        { scale: 0.5, opacity: 1 },
        {
          scale: 1.5,
          opacity: 0,
          duration: 1.5,
          ease: "power2.out",
          repeat: -1,
          delay: i * 0.4,
        }
      );
    });

    return () => {
      rings.forEach((ring) => gsap.killTweensOf(ring));
    };
  }, []);

  const center = size / 2;
  const radius = size * 0.3;

  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className={className}>
      <circle
        ref={ring1Ref}
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={2}
        style={{ transformOrigin: "center" }}
      />
      <circle
        ref={ring2Ref}
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={2}
        style={{ transformOrigin: "center" }}
      />
      <circle
        ref={ring3Ref}
        cx={center}
        cy={center}
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth={2}
        style={{ transformOrigin: "center" }}
      />
    </svg>
  );
}

export function GsapSyncSpinner({ size = 32, className = "" }: { size?: number; className?: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const arrowsRef = useRef<SVGPathElement[]>([]);

  useEffect(() => {
    if (!containerRef.current) return;

    const tl = gsap.timeline({ repeat: -1 });

    tl.to(arrowsRef.current, {
      rotation: 360,
      duration: 1,
      ease: "power1.inOut",
      stagger: 0.1,
      transformOrigin: "center center",
    });

    return () => {
      tl.kill();
    };
  }, []);

  return (
    <div ref={containerRef} className={`relative ${className}`} style={{ width: size, height: size }}>
      <svg viewBox="0 0 24 24" width={size} height={size} className="text-accent">
        <path
          ref={(el) => { if (el) arrowsRef.current[0] = el; }}
          d="M21 12a9 9 0 1 1-9-9"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
        />
        <path
          ref={(el) => { if (el) arrowsRef.current[1] = el; }}
          d="M21 3v6h-6"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    </div>
  );
}
