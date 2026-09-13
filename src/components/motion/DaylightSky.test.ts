import { describe, it, expect } from "vitest";
import { computeSky } from "./DaylightSky";

const at = (hour: number) => new Date(2026, 8, 13, hour, 0);

function channels(rgba: string): number[] {
  const m = /rgba\((\d+),(\d+),(\d+),/.exec(rgba);
  if (!m) throw new Error(`not an rgba string: ${rgba}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

describe("computeSky in the light theme", () => {
  it("shows neither moon nor stars at night", () => {
    const sky = computeSky(at(2), true);
    expect(sky.orb.opacity).toBe(0);
    expect(sky.starOpacity).toBe(0);
  });

  it("keeps the sun by day", () => {
    expect(computeSky(at(13), true).orb.opacity).toBeGreaterThan(0);
  });

  it("paints pastels instead of the dark palette", () => {
    const [r, g, b] = channels(computeSky(at(2), true).top);
    expect(Math.min(r, g, b)).toBeGreaterThan(180);
  });
});

describe("computeSky in the dark theme", () => {
  it("still shows the moon and stars at night", () => {
    const sky = computeSky(at(2), false);
    expect(sky.orb.opacity).toBeGreaterThan(0);
    expect(sky.starOpacity).toBeGreaterThan(0);
    expect(Math.max(...channels(sky.top))).toBeLessThan(80);
  });
});
