import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isWindows } from "../lib/platform";

/**
 * Windows caption integration for the custom title bars.
 *
 * Attach the returned ref to the maximize button: its client rect is reported
 * to the native side, which answers WM_NCHITTEST with HTMAXBUTTON there — that
 * is what makes Windows 11 show the Snap Layouts flyout on hover. The button
 * then lives in non-client space, so CSS :hover never fires; `hovered` mirrors
 * the native hover state back for styling, and the click is handled natively.
 */
export function useWindowsCaptionMaxButton() {
  const ref = useRef<HTMLButtonElement | null>(null);
  const [hovered, setHovered] = useState(false);

  useEffect(() => {
    if (!isWindows) return;

    const report = () => {
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      invoke("set_caption_max_rect", {
        x: rect.left,
        y: rect.top,
        w: rect.width,
        h: rect.height,
      }).catch(() => {});
    };

    report();
    // Layout settles after fonts/first paint; the rect also moves on every
    // window resize (buttons are right-aligned) and on maximize/restore.
    const settle = window.setTimeout(report, 500);
    window.addEventListener("resize", report);

    const unlisten = getCurrentWindow().listen<boolean>("caption-max-hover", (event) => {
      setHovered(event.payload);
    });

    return () => {
      window.clearTimeout(settle);
      window.removeEventListener("resize", report);
      unlisten.then((fn) => fn());
    };
  }, []);

  return { ref, hovered };
}

/** Right-click on the title bar: open the native window menu at the cursor. */
export function showSystemMenu(event: { clientX: number; clientY: number; preventDefault(): void }) {
  if (!isWindows) return;
  event.preventDefault();
  invoke("show_system_menu", { x: event.clientX, y: event.clientY }).catch(() => {});
}
