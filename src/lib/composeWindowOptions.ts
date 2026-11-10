import { LogicalPosition } from "@tauri-apps/api/dpi";

export interface ComposeGeometry {
  w: number;
  h: number;
  x?: number;
  y?: number;
}

export function backgroundFor(dark: boolean): [number, number, number, number] {
  return dark ? [18, 18, 20, 255] : [255, 255, 255, 255];
}

export function composeWindowOptions(dark: boolean, g: ComposeGeometry, macOS: boolean) {
  return {
    url: "index.html?compose=true",
    title: "Compose",
    width: g.w,
    height: g.h,
    minWidth: 500,
    minHeight: 400,
    x: g.x,
    y: g.y,
    center: g.x === undefined,
    // macOS: native decorations with overlay title bar (traffic lights over
    // our custom bar, real rounded corners). Windows/Linux: frameless.
    decorations: macOS,
    ...(macOS
      ? {
          titleBarStyle: "overlay" as const,
          hiddenTitle: true,
          trafficLightPosition: new LogicalPosition(12, 16),
          // WKWebView ignores the background colour below and paints white until its first frame; transparent, it shows the window's.
          transparent: true,
        }
      : {}),
    // Native window background matching the theme, so the window never flashes
    // WebView2's white default before the web content paints.
    backgroundColor: backgroundFor(dark),
    maximizable: true,
    visible: false,
    dragDropEnabled: false,
  };
}
