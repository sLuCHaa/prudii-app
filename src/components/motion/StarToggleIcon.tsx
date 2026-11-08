import { useEffect, useRef, useState } from "react";
import { STAR_AREA, STAR_FILL, STAR_OUTLINE } from "../icons/starPaths";
import { STAR_DURATION, starFrame, type StarMotion } from "../../lib/starMotion";
import { prefersReducedMotion } from "./tokens";

const RING_RADIUS_PX = 11;
const RING_STROKE_PX = 2;
const CLICK_WINDOW_MS = 1000;

interface StarToggleIconProps {
  starred: boolean;
  size: number;
  /** Shows the duotone area while not starred. */
  duotone?: boolean;
  hoverWiggle?: boolean;
  className?: string;
}

// SVG attributes, not CSS transforms: a composited animation blurs row text in WebKit.
export function StarToggleIcon({ starred, size, duotone = false, hoverWiggle = false, className = "" }: StarToggleIconProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const groupRef = useRef<SVGGElement>(null);
  const clickedAt = useRef(-Infinity);
  const ringRef = useRef<SVGCircleElement>(null);
  const frame = useRef<number | null>(null);
  const shownStarred = useRef(starred);
  const [hovered, setHovered] = useState(false);
  const unit = 256 / size;

  const play = (kind: StarMotion) => {
    if (prefersReducedMotion()) return;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    const start = performance.now();
    const step = (now: number) => {
      const ms = now - start;
      const f = starFrame(kind, ms);
      groupRef.current?.setAttribute("transform", `translate(128 128) rotate(${f.rotate}) scale(${f.scale}) translate(-128 -128)`);
      ringRef.current?.setAttribute("r", String(f.ringScale * RING_RADIUS_PX * unit));
      ringRef.current?.setAttribute("stroke-opacity", String(f.ringOpacity));
      frame.current = ms < STAR_DURATION[kind] ? requestAnimationFrame(step) : null;
    };
    frame.current = requestAnimationFrame(step);
  };

  // Spin only where the star was clicked, not in every row a bulk change touches.
  useEffect(() => {
    const button = svgRef.current?.closest("button");
    if (!button) return;
    const arm = () => { clickedAt.current = performance.now(); };
    button.addEventListener("click", arm);
    return () => button.removeEventListener("click", arm);
  }, []);

  useEffect(() => {
    if (shownStarred.current === starred) return;
    shownStarred.current = starred;
    if (performance.now() - clickedAt.current > CLICK_WINDOW_MS) return;
    clickedAt.current = -Infinity;
    play(starred ? "on" : "off");
  }, [starred]);

  useEffect(() => () => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
  }, []);

  const filled = starred || hovered;
  return (
    <svg
      ref={svgRef}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="currentColor"
      aria-hidden
      className={className}
      style={{ overflow: "visible" }}
      onPointerEnter={hoverWiggle ? () => {
        if (starred) return;
        setHovered(true);
        if (frame.current === null) play("wiggle");
      } : undefined}
      onPointerLeave={hoverWiggle ? () => setHovered(false) : undefined}
    >
      <g ref={groupRef}>
        <path
          className="star-toggle-fill"
          d={STAR_FILL}
          fillOpacity={filled ? 1 : 0}
          style={{ transition: "fill-opacity 0.18s ease" }}
        />
        {duotone && !filled && <path d={STAR_AREA} opacity={0.2} />}
        <path d={STAR_OUTLINE} />
      </g>
      <circle
        ref={ringRef}
        cx={128}
        cy={128}
        r={0}
        fill="none"
        stroke="#fbbf24"
        strokeWidth={RING_STROKE_PX * unit}
        strokeOpacity={0}
        pointerEvents="none"
      />
    </svg>
  );
}
