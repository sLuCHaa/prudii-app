import { describe, expect, it } from "vitest";
import { starFrame, STAR_DURATION } from "./starMotion";

describe("starFrame", () => {
  it("starts the spin turned back and small, with the ring close in", () => {
    const f = starFrame("on", 0);
    expect(f.rotate).toBeCloseTo(-72);
    expect(f.scale).toBeCloseTo(0.6);
    expect(f.ringScale).toBeCloseTo(0.4);
    expect(f.ringOpacity).toBeCloseTo(0.9);
  });

  it("overshoots at 70 % of the spin", () => {
    const f = starFrame("on", 350);
    expect(f.rotate).toBeCloseTo(5);
    expect(f.scale).toBeCloseTo(1.12);
  });

  it("settles with the ring gone", () => {
    const f = starFrame("on", 580);
    expect(f).toEqual({ rotate: 0, scale: 1, ringScale: 1.7, ringOpacity: 0 });
    expect(starFrame("on", 9999)).toEqual(f);
  });

  it("shrinks briefly when unstarred", () => {
    expect(starFrame("off", 108).scale).toBeCloseTo(0.78);
    expect(starFrame("off", 240).scale).toBeCloseTo(1);
    expect(starFrame("off", 108).ringOpacity).toBe(0);
  });

  it("wiggles on hover", () => {
    expect(starFrame("wiggle", 167).rotate).toBeCloseTo(-5);
    expect(starFrame("wiggle", 333).rotate).toBeCloseTo(5);
    expect(starFrame("wiggle", 250).scale).toBeCloseTo(1.1);
    expect(starFrame("wiggle", 500)).toEqual({ rotate: 0, scale: 1, ringScale: 0, ringOpacity: 0 });
  });

  it("lasts as long as its longest part", () => {
    expect(STAR_DURATION).toEqual({ on: 580, off: 240, wiggle: 500 });
  });
});
