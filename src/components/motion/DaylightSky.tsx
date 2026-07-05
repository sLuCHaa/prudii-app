// Tinted time-of-day sky for empty states ("atmosphere"). Pure CSS gradients
// interpolated by minute-of-day, a sun/moon glow orb on a sine arc, and a few
// twinkling stars at night. No geolocation, no weather, no network — local
// clock only. Renders absolute + pointer-events-none behind empty-state
// content; only mounted while an empty state is visible.

import { useEffect, useMemo, useState } from "react";
import { useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";

export type DayPhase = "dawn" | "day" | "dusk" | "night";

/** Text-pool phase for the current local time (deep night uses the night pool). */
export function getDayPhase(date: Date): DayPhase {
  const h = date.getHours();
  if (h >= 5 && h < 8) return "dawn";
  if (h >= 8 && h < 17) return "day";
  if (h >= 17 && h < 21) return "dusk";
  return "night";
}

/** Random time-of-day one-liner for an empty-state context, picked once per
 *  mount. Returns undefined when the locale has no pool (caller falls back
 *  to the existing static description string). */
export function useAtmosphereLine(context: "selectMail" | "inboxZero"): string | undefined {
  const { t } = useTranslation();
  // useState lazy init guarantees the random pick happens exactly once per
  // mount — useMemo is only a performance hint and may legally recompute.
  const [line] = useState<string | undefined>(() => {
    const phase = getDayPhase(new Date());
    const lines = t(`atmosphere.${context}.${phase}`, { returnObjects: true });
    if (Array.isArray(lines) && lines.length > 0) {
      return String(lines[Math.floor(Math.random() * lines.length)]);
    }
    return undefined;
  });
  return line;
}

type Rgb = [number, number, number];

// Palette anchors on the 24h clock (minute-of-day). The rendered gradient is
// a linear interpolation between the two surrounding anchors, so the sky
// never switches hard. Alpha is applied uniformly (tinted look, style "B2").
const SKY_ANCHORS: { at: number; top: Rgb; bottom: Rgb }[] = [
  { at: 0,    top: [11, 16, 38],   bottom: [27, 35, 64] },    // midnight
  { at: 300,  top: [13, 18, 42],   bottom: [30, 38, 70] },    // 05:00 late night
  { at: 390,  top: [43, 42, 78],   bottom: [176, 106, 91] },  // 06:30 dawn
  { at: 540,  top: [61, 107, 181], bottom: [168, 198, 232] }, // 09:00 morning
  { at: 780,  top: [74, 123, 196], bottom: [196, 217, 239] }, // 13:00 midday
  { at: 1020, top: [75, 69, 119],  bottom: [217, 142, 106] }, // 17:00 golden hour
  { at: 1170, top: [43, 38, 80],   bottom: [150, 90, 90] },   // 19:30 dusk
  { at: 1320, top: [18, 20, 46],   bottom: [42, 47, 85] },    // 22:00 night
  { at: 1440, top: [11, 16, 38],   bottom: [27, 35, 64] },    // wrap to midnight
];

const TINT_ALPHA = 0.35;

// Deterministic star field (percent positions, px sizes, twinkle timing).
const STARS = [
  { x: 12, y: 16, size: 2,   dur: 4.2, delay: 0 },
  { x: 24, y: 32, size: 1.5, dur: 5.1, delay: 1.2 },
  { x: 33, y: 10, size: 2,   dur: 3.8, delay: 2.1 },
  { x: 45, y: 24, size: 1.5, dur: 4.6, delay: 0.6 },
  { x: 56, y: 14, size: 2.5, dur: 5.4, delay: 1.8 },
  { x: 64, y: 36, size: 1.5, dur: 4.1, delay: 3.0 },
  { x: 73, y: 12, size: 2,   dur: 4.9, delay: 0.9 },
  { x: 82, y: 28, size: 1.5, dur: 3.6, delay: 2.4 },
  { x: 90, y: 18, size: 2,   dur: 5.0, delay: 1.5 },
  { x: 18, y: 46, size: 1.5, dur: 4.4, delay: 3.6 },
];

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
}

function rgba([r, g, b]: Rgb, alpha: number): string {
  return `rgba(${Math.round(r)},${Math.round(g)},${Math.round(b)},${alpha})`;
}

interface SkyState {
  top: string;
  bottom: string;
  orb: { x: number; y: number; opacity: number; bg: string; glow: string };
  starOpacity: number;
}

/** Raw (un-alphaed) sky colors interpolated for the given time of day. */
function computeSkyColors(date: Date): { top: Rgb; bottom: Rgb } {
  const m = date.getHours() * 60 + date.getMinutes();
  let hi = SKY_ANCHORS.findIndex((a) => a.at >= m);
  if (hi <= 0) hi = 1;
  const lo = hi - 1;
  const span = SKY_ANCHORS[hi].at - SKY_ANCHORS[lo].at;
  const t = span === 0 ? 0 : (m - SKY_ANCHORS[lo].at) / span;
  return {
    top: lerpRgb(SKY_ANCHORS[lo].top, SKY_ANCHORS[hi].top, t),
    bottom: lerpRgb(SKY_ANCHORS[lo].bottom, SKY_ANCHORS[hi].bottom, t),
  };
}

/** Time-of-day sky gradient (top/bottom rgba strings) at the given alpha.
 *  Ticks once per minute — same cadence as DaylightSky. Used by the
 *  ambient sidebar tint on Windows/Linux. */
export function useSkyGradient(alpha: number): { top: string; bottom: string } {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);
  return useMemo(() => {
    const { top, bottom } = computeSkyColors(now);
    return { top: rgba(top, alpha), bottom: rgba(bottom, alpha) };
  }, [now, alpha]);
}

function computeSky(date: Date): SkyState {
  const m = date.getHours() * 60 + date.getMinutes();

  const { top, bottom } = computeSkyColors(date);

  // Orb: sun 06:00–20:00, moon 20:00–06:00 (window crosses midnight).
  const isSun = m >= 360 && m < 1200;
  const winStart = isSun ? 360 : 1200;
  const winLen = isSun ? 840 : 600;
  const p = (((m - winStart + 1440) % 1440)) / winLen;
  const x = 8 + 84 * p;
  const y = 78 - 58 * Math.sin(Math.PI * p);
  // Fade the orb in/out near the horizon edges of its window.
  const edge = Math.min(p, 1 - p);
  const opacity = Math.max(0, Math.min(1, edge / 0.08)) * (isSun ? 0.65 : 0.8);
  const orb = {
    x,
    y,
    opacity,
    bg: isSun
      ? "radial-gradient(circle at 35% 35%, #fff3cf, #f0b45f)"
      : "radial-gradient(circle at 35% 35%, #f4f6ff, #b9c3e8)",
    glow: isSun
      ? "0 0 34px 12px rgba(240,180,95,.30)"
      : "0 0 26px 10px rgba(185,195,232,.25)",
  };

  // Stars: fully visible 21:30–04:30, fading over 60 min at each edge.
  let starOn = 0;
  if (m >= 1290 || m < 270) starOn = 1;
  else if (m >= 1230 && m < 1290) starOn = (m - 1230) / 60;
  else if (m >= 270 && m < 330) starOn = 1 - (m - 270) / 60;

  return {
    top: rgba(top, TINT_ALPHA),
    bottom: rgba(bottom, TINT_ALPHA),
    orb,
    starOpacity: starOn * 0.8,
  };
}

export function DaylightSky({ className = "" }: { className?: string }) {
  const reducedMotion = useReducedMotion();
  const [now, setNow] = useState(() => new Date());

  // Palette/orb deltas per minute are sub-pixel — a 60 s tick is plenty and
  // costs nothing. No rAF, no transitions.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  const sky = useMemo(() => computeSky(now), [now]);

  return (
    <div
      aria-hidden
      className={`absolute inset-0 overflow-hidden pointer-events-none ${className}`}
    >
      <style>{`@keyframes dsky-twinkle { 0%, 100% { opacity: .15; } 50% { opacity: .7; } }`}</style>
      <div
        className="absolute inset-0"
        style={{ background: `linear-gradient(180deg, ${sky.top} 0%, ${sky.bottom} 100%)` }}
      />
      <div
        className="absolute rounded-full"
        style={{
          left: `${sky.orb.x}%`,
          top: `${sky.orb.y}%`,
          width: 48,
          height: 48,
          transform: "translate(-50%, -50%)",
          background: sky.orb.bg,
          boxShadow: sky.orb.glow,
          opacity: sky.orb.opacity,
        }}
      />
      {sky.starOpacity > 0 && (
        <div className="absolute inset-0" style={{ opacity: sky.starOpacity }}>
          {STARS.map((s, i) => (
            <div
              key={i}
              className="absolute rounded-full bg-white"
              style={{
                left: `${s.x}%`,
                top: `${s.y}%`,
                width: s.size,
                height: s.size,
                animation: reducedMotion
                  ? undefined
                  : `dsky-twinkle ${s.dur}s ease-in-out ${s.delay}s infinite`,
                opacity: reducedMotion ? 0.4 : undefined,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
