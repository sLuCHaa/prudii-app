import { forwardRef, useImperativeHandle } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./types";
import { motion, useAnimate } from "motion/react";

// Phosphor „MagnifyingGlass“ (Duotone); wackelt beim Hover wie eine suchende Lupe.
const LENS_AREA = "M192,112a80,80,0,1,1-80-80A80,80,0,0,1,192,112Z";
const OUTLINE =
  "M229.66,218.34l-50.07-50.06a88.11,88.11,0,1,0-11.31,11.31l50.06,50.07a8,8,0,0,0,11.32-11.32ZM40,112a72,72,0,1,1,72,72A72.08,72.08,0,0,1,40,112Z";

// Die Wege stammen vom 32er-Raster der alten Version (×256/32).
const UNIT = 256 / 32;

const MagnifierIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  ({ size = 24, color = "currentColor", className = "" }, ref) => {
    const [scope, animate] = useAnimate();

    const start = async () => {
      await animate(
        ".magnifier-group",
        {
          x: [0, 1 * UNIT, 0, -1 * UNIT, 0],
          y: [0, -1 * UNIT, -2 * UNIT, -1 * UNIT, 0],
          rotate: [0, -5, 5, -5, 0],
        },
        { duration: 1, ease: "easeInOut" },
      );
    };

    const stop = () => {
      animate(
        ".magnifier-group",
        { x: 0, y: 0, rotate: 0 },
        { duration: 0.2, ease: "easeOut" },
      );
    };

    useImperativeHandle(ref, () => ({
      startAnimation: start,
      stopAnimation: stop,
    }));

    return (
      <motion.svg
        ref={scope}
        onHoverStart={start}
        onHoverEnd={stop}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 256 256"
        fill={color}
        aria-hidden
        className={`pi cursor-pointer ${className}`}
        style={{ overflow: "visible" }}
      >
        {/* Drehpunkt in der Linsenmitte (112/112 von 24…232 im Rahmen). */}
        <motion.g
          className="magnifier-group"
          style={{ transformOrigin: "42% 42%", transformBox: "fill-box" }}
        >
          <path d={LENS_AREA} opacity="0.2" />
          <path d={OUTLINE} />
        </motion.g>
      </motion.svg>
    );
  },
);

MagnifierIcon.displayName = "MagnifierIcon";
export default MagnifierIcon;
