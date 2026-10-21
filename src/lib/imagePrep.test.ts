import { afterEach, describe, expect, it, vi } from "vitest";
import { base64Size, planImage, prepareImage } from "./imagePrep";
import { hasGpsData } from "./imageMetadata";

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

const ascii = (s: string) => Array.from(s, (c) => c.charCodeAt(0));
const GPS_EXIF = [
  ...ascii("Exif\0\0II*\0"), 8, 0, 0, 0,
  1, 0, 0x25, 0x88, 4, 0, 1, 0, 0, 0, 26, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0,
];
const CLEAN_JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xda, 0, 8, 1, 2, 3, 4, 5, 6, 7, 8, 9, 0xff, 0xd9]);
const GPS_JPEG = Uint8Array.from([
  0xff, 0xd8,
  0xff, 0xe1, 0, GPS_EXIF.length + 2, ...GPS_EXIF,
  ...CLEAN_JPEG.slice(2),
  ...ascii("trailer with the uncropped picture"),
]);
const PNG_HEAD = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const pngChunk = (type: string, body: number[] = []) => [0, 0, 0, body.length, ...ascii(type), ...body, 0, 0, 0, 0];
const CLEAN_PNG = Uint8Array.from([...PNG_HEAD, ...pngChunk("IHDR", new Array(13).fill(0)), ...pngChunk("IEND")]);
const TEXT_PNG = Uint8Array.from([
  ...PNG_HEAD,
  ...pngChunk("IHDR", new Array(13).fill(0)),
  ...pngChunk("tEXt", ascii("Author\0me")),
  ...pngChunk("IEND"),
  ...ascii("junk"),
]);

const decoded = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const undecodable = () => Promise.reject(new DOMException("The source image could not be decoded.", "InvalidStateError"));

describe("prepareImage when the webview cannot decode", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a JPEG stripped instead of raw", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(undecodable));
    const out = await prepareImage(new File([GPS_JPEG], "IMG_1.jpg", { type: "image/jpeg" }));
    expect(out).toMatchObject({ type: "image/jpeg", name: "IMG_1.jpg", width: 0, height: 0, shrunkFrom: null, original: null, locationRemoved: true });
    expect(decoded(out!.data)).toEqual(CLEAN_JPEG);
    expect(out!.size).toBe(CLEAN_JPEG.length);
    expect(hasGpsData(decoded(out!.data))).toBe(false);
  });

  it("sends a PNG stripped instead of raw", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(undecodable));
    const out = await prepareImage(new File([TEXT_PNG], "image.png", { type: "image/png" }));
    expect(out).toMatchObject({ type: "image/png", width: 0, locationRemoved: false });
    expect(decoded(out!.data)).toEqual(CLEAN_PNG);
  });

  it("gives up only when nothing safe can be made", async () => {
    vi.stubGlobal("createImageBitmap", vi.fn(undecodable));
    expect(await prepareImage(new File([GPS_JPEG], "photo.heic", { type: "image/heic" }))).toBeNull();
    expect(await prepareImage(new File([GPS_JPEG.slice(0, 30)], "cut.jpg", { type: "image/jpeg" }))).toBeNull();
  });

  it("retries without options when the webview rejects them", async () => {
    const decode = vi.fn((_file: Blob, options?: ImageBitmapOptions) =>
      options ? Promise.reject(new TypeError("unknown option")) : Promise.resolve({ width: 120, height: 90, close: () => {} }),
    );
    vi.stubGlobal("createImageBitmap", decode);
    const out = await prepareImage(new File([GPS_JPEG], "IMG_2.jpg", { type: "image/jpeg" }));
    expect(decode).toHaveBeenCalledTimes(2);
    expect(decode.mock.calls[1]).toHaveLength(1);
    expect(out).toMatchObject({ width: 120, height: 90, locationRemoved: true });
    expect(decoded(out!.data)).toEqual(CLEAN_JPEG);
  });
});
