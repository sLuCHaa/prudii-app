import { forwardRef, useImperativeHandle, useCallback } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./types";
import { motion, useAnimate } from "motion/react";
import { STAR_AREA, STAR_FILL, STAR_OUTLINE } from "./starPaths";

// Duotone at rest; the fill weight fades in on hover.
const StarIcon = forwardRef<AnimatedIconHandle, AnimatedIconProps>(
  ({ size = 24, color = "currentColor", className = "" }, ref) => {
    const [scope, animate] = useAnimate();

    const start = useCallback(async () => {
      animate(
        ".star-fill",
        { opacity: [0, 1], scale: [0.8, 1] },
        { duration: 0.4, ease: "easeOut" },
      );
      animate(
        ".star-outline",
        { scale: [1, 1.1, 1], rotate: [0, -5, 5, 0] },
        { duration: 0.5, ease: "easeInOut" },
      );
    }, [animate]);

    const stop = useCallback(() => {
      animate(
        ".star-fill",
        { opacity: [1, 0] },
        { duration: 0.3, ease: "easeOut" },
      );
      animate(
        ".star-outline",
        { scale: 1, rotate: 0 },
        { duration: 0.3, ease: "easeInOut" },
      );
    }, [animate]);

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
      >
        <motion.path
          className="star-fill"
          d={STAR_FILL}
          opacity={0}
          style={{ transformOrigin: "center", transformBox: "fill-box" }}
        />
        <motion.g
          className="star-outline"
          style={{ transformOrigin: "center", transformBox: "fill-box" }}
        >
          <path d={STAR_AREA} opacity="0.2" />
          <path d={STAR_OUTLINE} />
        </motion.g>
      </motion.svg>
    );
  },
);

StarIcon.displayName = "StarIcon";
export default StarIcon;
