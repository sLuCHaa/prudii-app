export type StarMotion = "on" | "off" | "wiggle";

export const STAR_DURATION: Record<StarMotion, number> = { on: 580, off: 240, wiggle: 500 };

export interface StarFrame {
  rotate: number;
  scale: number;
  ringScale: number;
  ringOpacity: number;
}

type Key = readonly [ms: number, value: number];

const TRACKS: Record<StarMotion, Record<keyof StarFrame, readonly Key[]>> = {
  on: {
    rotate: [[0, -72], [350, 5], [500, 0]],
    scale: [[0, 0.6], [350, 1.12], [500, 1]],
    ringScale: [[0, 0.4], [580, 1.7]],
    ringOpacity: [[0, 0.9], [580, 0]],
  },
  off: {
    rotate: [[0, 0]],
    scale: [[0, 1], [108, 0.78], [240, 1]],
    ringScale: [[0, 0]],
    ringOpacity: [[0, 0]],
  },
  wiggle: {
    rotate: [[0, 0], [167, -5], [333, 5], [500, 0]],
    scale: [[0, 1], [250, 1.1], [500, 1]],
    ringScale: [[0, 0]],
    ringOpacity: [[0, 0]],
  },
};

const easeOut = (x: number) => 1 - (1 - x) ** 3;

function valueAt(keys: readonly Key[], ms: number): number {
  for (let i = 1; i < keys.length; i++) {
    const [t0, v0] = keys[i - 1];
    const [t1, v1] = keys[i];
    if (ms < t1) return v0 + (v1 - v0) * easeOut(Math.max(0, ms - t0) / (t1 - t0));
  }
  return keys[keys.length - 1][1];
}

/** The star's pose `ms` into a motion; each keyframe segment eases out. */
export function starFrame(kind: StarMotion, ms: number): StarFrame {
  const t = TRACKS[kind];
  const at = Math.min(Math.max(ms, 0), STAR_DURATION[kind]);
  return {
    rotate: valueAt(t.rotate, at),
    scale: valueAt(t.scale, at),
    ringScale: valueAt(t.ringScale, at),
    ringOpacity: valueAt(t.ringOpacity, at),
  };
}
