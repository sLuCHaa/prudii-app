import { describe, expect, it } from "vitest";
import { base64Size, planImage } from "./imagePrep";

describe("planImage", () => {
  it("shrinks big photos to 2048 px as JPEG at 85 %", () => {
    expect(planImage({ type: "image/jpeg", size: 4.8e6, width: 4032, height: 3024, orientation: 1 }))
      .toEqual({ reencode: true, maxEdge: 2048, outputType: "image/jpeg", quality: 0.85 });
    expect(planImage({ type: "image/jpeg", size: 2e6, width: 1600, height: 1200, orientation: 1 })?.reencode).toBe(true);
  });
  it("only strips small, upright photos", () => {
    expect(planImage({ type: "image/jpeg", size: 4e5, width: 1600, height: 1200, orientation: 1 })?.reencode).toBe(false);
  });
  it("re-encodes a turned photo at 92 % without shrinking", () => {
    expect(planImage({ type: "image/jpeg", size: 4e5, width: 1600, height: 1200, orientation: 6 }))
      .toEqual({ reencode: true, maxEdge: Infinity, outputType: "image/jpeg", quality: 0.92 });
  });
  it("keeps PNG as PNG and shrinks it only by edge", () => {
    expect(planImage({ type: "image/png", size: 3e6, width: 1920, height: 1080, orientation: 1 })?.reencode).toBe(false);
    expect(planImage({ type: "image/png", size: 3e6, width: 3840, height: 2160, orientation: 1 }))
      .toMatchObject({ reencode: true, outputType: "image/png" });
  });
  it("converts small WebP without shrinking", () => {
    expect(planImage({ type: "image/webp", size: 3e5, width: 800, height: 600, orientation: 1 }))
      .toEqual({ reencode: true, maxEdge: Infinity, outputType: "image/jpeg", quality: 0.92 });
  });
  it("turns WebP and HEIC into JPEG and leaves GIF alone", () => {
    expect(planImage({ type: "image/webp", size: 3e5, width: 800, height: 600, orientation: 1 })).toMatchObject({ reencode: true, outputType: "image/jpeg" });
    expect(planImage({ type: "image/heic", size: 2e6, width: 4032, height: 3024, orientation: 1 })).toMatchObject({ reencode: true, outputType: "image/jpeg" });
    expect(planImage({ type: "image/gif", size: 2e6, width: 800, height: 600, orientation: 1 })).toBeNull();
  });
});

describe("base64Size", () => {
  it("measures base64 payloads", () => {
    expect(base64Size("aGVsbG8=")).toBe(5);
  });
});
