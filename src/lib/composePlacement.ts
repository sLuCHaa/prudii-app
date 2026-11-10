export type ComposeTarget = "dock" | "window";

/** The dock holds one compose; a second one opens as a window, so the first is never replaced. */
export function composeTarget(docked: boolean, dockBusy: boolean): ComposeTarget {
  return docked && !dockBusy ? "dock" : "window";
}
