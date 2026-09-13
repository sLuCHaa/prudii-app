// Ambient time-of-day tint for the sidebar on Windows/Linux, where no native
// window vibrancy exists (macOS uses NSVisualEffectView instead — see
// set_vibrancy in lib.rs). Renders a very low-alpha DaylightSky gradient over
// the opaque .glass-sidebar base, so text contrast stays deterministic
// regardless of the user's wallpaper.

import { useAppStore } from "../../stores/appStore";
import { isMacOS } from "../../lib/platform";
import { pastel, rgba, useSkyGradient } from "../motion/DaylightSky";

export function SidebarAmbient() {
  const enabled = useAppStore((s) => s.appSettings.transparent_sidebar);
  const darkMode = useAppStore((s) => s.darkMode);
  // Hooks must run unconditionally (rules of hooks); the cost when the
  // layer is inactive is one state tick per minute.
  const sky = useSkyGradient(0.08);

  if (isMacOS || !enabled) return null;

  // Light theme: pastel hues; the dark palette at low alpha over the light surface only grays it.
  const top = darkMode ? sky.top : rgba(pastel(sky.topRgb, 0.9), 0.45);
  const bottom = darkMode ? sky.bottom : rgba(pastel(sky.bottomRgb, 0.94), 0.45);

  return (
    <div
      aria-hidden
      className="absolute inset-0 -z-10 pointer-events-none"
      style={{ background: `linear-gradient(180deg, ${top} 0%, ${bottom} 100%)` }}
    />
  );
}
