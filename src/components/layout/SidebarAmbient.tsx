// Ambient time-of-day tint for the sidebar on Windows/Linux, where no native
// window vibrancy exists (macOS uses NSVisualEffectView instead — see
// set_vibrancy in lib.rs). Renders a very low-alpha DaylightSky gradient over
// the opaque .glass-sidebar base, so text contrast stays deterministic
// regardless of the user's wallpaper.

import { useAppStore } from "../../stores/appStore";
import { isMacOS } from "../../lib/platform";
import { useSkyGradient } from "../motion/DaylightSky";

export function SidebarAmbient() {
  const enabled = useAppStore((s) => s.appSettings.transparent_sidebar);
  const darkMode = useAppStore((s) => s.darkMode);
  // Hooks must run unconditionally (rules of hooks); the cost when the
  // layer is inactive is one state tick per minute.
  const { top, bottom } = useSkyGradient(darkMode ? 0.08 : 0.05);

  if (isMacOS || !enabled) return null;

  return (
    <div
      aria-hidden
      className="absolute inset-0 -z-10 pointer-events-none"
      style={{ background: `linear-gradient(180deg, ${top} 0%, ${bottom} 100%)` }}
    />
  );
}
