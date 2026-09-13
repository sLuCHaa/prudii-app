// Time-of-day sky behind the reading pane on Windows/Linux, the counterpart of
// SidebarAmbient: an opened mail sits on the sky the empty state showed instead
// of a flat surface. Minute ticks only, so reduced-motion needs no special case.

import { useAppStore } from "../../stores/appStore";
import { isMacOS } from "../../lib/platform";
import { pastel, rgba, useSkyGradient } from "../motion/DaylightSky";

// Empty margins carry more color than the sidebar behind its text.
const DARK_TINT_ALPHA = 0.22;

export function ReadingAmbient() {
  const enabled = useAppStore((s) => s.appSettings.transparent_sidebar);
  const darkMode = useAppStore((s) => s.darkMode);
  const sky = useSkyGradient(DARK_TINT_ALPHA);

  if (isMacOS || !enabled) return null;

  // Light theme: pastel hues; the dark palette at low alpha over white only grays.
  const top = darkMode ? sky.top : rgba(pastel(sky.topRgb, 0.9), 0.85);
  const bottom = darkMode ? sky.bottom : rgba(pastel(sky.bottomRgb, 0.94), 0.85);

  const isSun = sky.glow.rgb[0] > sky.glow.rgb[2];
  const light = darkMode
    ? isSun ? [255, 214, 150] : [200, 210, 245]
    : isSun ? [255, 196, 110] : [160, 175, 235];
  const peak = darkMode ? 0.3 : 0.35;
  const [r, g, b] = light;

  return (
    <div aria-hidden className="absolute inset-0 -z-10 overflow-hidden pointer-events-none">
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(180deg, ${top} 0%, ${bottom} 100%)` }}
      />
      {/* Wider than the pane so the light reads as a direction while the orb stands behind the card. */}
      <div
        className="absolute inset-0"
        style={{
          background: `radial-gradient(ellipse 110% 85% at ${sky.glow.x}% ${sky.glow.y}%, rgba(${r},${g},${b},${peak}) 0%, rgba(${r},${g},${b},0) 65%)`,
          opacity: sky.glow.opacity,
        }}
      />
    </div>
  );
}
