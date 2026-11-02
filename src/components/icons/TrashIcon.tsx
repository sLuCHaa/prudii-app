import { forwardRef, useImperativeHandle, useCallback, useState } from "react";
import type { AnimatedIconHandle, AnimatedIconProps } from "./types";
import { motion, useAnimate } from "motion/react";

// Phosphor „Trash“ (Duotone), zerlegt in Deckelgriff, Deckelleiste und Korpus,
// damit der Deckel beim Hover aufklappen kann. 256er-Raster wie Phosphor.
const LID_HANDLE = "M80,48V40a24,24,0,0,1,24-24h48a24,24,0,0,1,24,24v8H160V40a8,8,0,0,0-8-8H104a8,8,0,0,0-8,8v8Z";
const LID_BAR = "M40,48H216a8,8,0,0,1,0,16H40a8,8,0,0,1,0-16Z";
const BODY =
  "M48,64V208a16,16,0,0,0,16,16H192a16,16,0,0,0,16-16V64H192V208H64V64Z" +
  "M112,104v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Zm48,0v64a8,8,0,0,1-16,0V104a8,8,0,0,1,16,0Z";
const BODY_AREA = "M200,64V208a8,8,0,0,1-8,8H64a8,8,0,0,1-8-8V64Z";

// Die Deckelwege stammen vom 24er-Raster der alten Version (×256/24).
const UNIT = 256 / 24;

export interface TrashIconProps extends AnimatedIconProps {
  shakeOnClick?: boolean;
  dangerHover?: boolean;
  keepOpenOnDelete?: boolean;
}

const TrashIcon = forwardRef<AnimatedIconHandle, TrashIconProps>(
  (
    {
      shakeOnClick = false,
      dangerHover = false,
      keepOpenOnDelete = false,
      size = 24,
      color = "currentColor",
      className = "",
    },
    ref,
  ) => {
    const [scope, animate] = useAnimate();
    const [danger, setDanger] = useState(false);

    const openLid = useCallback(async () => {
      await Promise.all([
        animate(
          ".trash-lid-lower",
          { rotate: -25, y: -4 * UNIT },
          { duration: 0.25, ease: "easeOut" },
        ),
        animate(
          ".trash-lid-upper",
          { rotate: -35, y: -6 * UNIT, x: -2 * UNIT },
          { duration: 0.25, ease: "easeOut" },
        ),
      ]);
    }, [animate]);

    const closeLid = useCallback(async () => {
      await Promise.all([
        animate(
          ".trash-lid-lower",
          { rotate: 0, y: 0 },
          { duration: 0.2, ease: "easeInOut" },
        ),
        animate(
          ".trash-lid-upper",
          { rotate: 0, y: 0, x: 0 },
          { duration: 0.2, ease: "easeInOut" },
        ),
      ]);
    }, [animate]);

    const hoverAnimation = useCallback(async () => {
      await openLid();
      if (dangerHover) setDanger(true);
    }, [openLid, dangerHover]);

    const hoverEndAnimation = useCallback(() => {
      setDanger(false);
      closeLid();
    }, [closeLid]);

    const clickAnimation = useCallback(async () => {
      if (shakeOnClick) {
        await animate(
          ".trash-icon",
          { x: [0, -2, 2, -1, 0] },
          { duration: 0.25, ease: "easeInOut" },
        );
      }

      if (keepOpenOnDelete) {
        await openLid();
      }
    }, [shakeOnClick, keepOpenOnDelete, animate, openLid]);

    useImperativeHandle(ref, () => ({
      startAnimation: openLid,
      stopAnimation: closeLid,
    }));

    return (
      <motion.svg
        ref={scope}
        className={`pi cursor-pointer ${className} trash-icon`}
        onHoverStart={hoverAnimation}
        onHoverEnd={hoverEndAnimation}
        onTap={clickAnimation}
        xmlns="http://www.w3.org/2000/svg"
        width={size}
        height={size}
        viewBox="0 0 256 256"
        fill={color}
        aria-hidden
        style={{
          color: danger ? "var(--c-danger)" : undefined,
          transition: "color 0.2s ease-in-out",
          overflow: "visible",
        }}
      >
        <path d={BODY_AREA} opacity="0.2" />
        <path d={BODY} />
        <motion.path
          d={LID_BAR}
          className="trash-lid-lower"
          style={{ transformOrigin: "50% 100%", transformBox: "fill-box" }}
        />
        <motion.path
          d={LID_HANDLE}
          className="trash-lid-upper"
          style={{ transformOrigin: "50% 100%", transformBox: "fill-box" }}
        />
      </motion.svg>
    );
  },
);

TrashIcon.displayName = "TrashIcon";
export default TrashIcon;
