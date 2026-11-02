import { useReducedMotion } from "motion/react";

// The reverse of the CSS modal-panel-in entrance, for modals inside AnimatePresence.
const OVERLAY_EXIT = { opacity: 0, transition: { duration: 0.14, ease: "easeIn" } } as const;
const PANEL_EXIT = { opacity: 0, scale: 0.97, y: 4, transition: { duration: 0.14, ease: "easeIn" } } as const;

export function useModalExit() {
  const reduce = useReducedMotion();
  return reduce ? { overlay: undefined, panel: undefined } : { overlay: OVERLAY_EXIT, panel: PANEL_EXIT };
}
