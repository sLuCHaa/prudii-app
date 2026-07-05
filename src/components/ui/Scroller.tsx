import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import type { ReactNode } from "react";

interface ScrollerProps {
  className?: string;
  children: ReactNode;
  /** Scroll axis. Defaults to vertical-only. */
  axis?: "y" | "x" | "both";
}

/**
 * App scroll container backed by OverlayScrollbars (real DOM scrollbars),
 * so the themed scrollbar renders regardless of WebView2's native overlay
 * scrollbars which ignore ::-webkit-scrollbar CSS. Styled via the
 * `os-theme-prudii` theme in index.css.
 */
export function Scroller({ className, children, axis = "y" }: ScrollerProps) {
  return (
    <OverlayScrollbarsComponent
      defer
      className={className}
      options={{
        scrollbars: {
          theme: "os-theme-prudii",
          autoHide: "leave",
          autoHideDelay: 500,
          clickScroll: true,
        },
        overflow: {
          x: axis === "x" || axis === "both" ? "scroll" : "hidden",
          y: axis === "y" || axis === "both" ? "scroll" : "hidden",
        },
      }}
    >
      {children}
    </OverlayScrollbarsComponent>
  );
}
