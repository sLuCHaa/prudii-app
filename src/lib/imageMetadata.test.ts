import { describe, expect, it } from "vitest";
import {
  hasGpsData,
  jpegOrientation,
  stripJpegMetadata,
  stripPngMetadata,
} from "./imageMetadata";

function bytes(s: string): Uint8Array {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

function text(b: Uint8Array): string {
  return Array.from(b, (x) => String.fromCharCode(x)).join("");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

function segment(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.length + 2;
  return concat(Uint8Array.of(marker >> 8, marker & 0xff, len >> 8, len & 0xff), payload);
}

function jpeg(...segments: Uint8Array[]): Uint8Array {
  return concat(
    Uint8Array.of(0xff, 0xd8),
    ...segments,
    Uint8Array.of(0xff, 0xda, 0, 8, 1, 2, 3, 4, 5, 6),
    Uint8Array.of(7, 8, 9),
    Uint8Array.of(0xff, 0xd9),
  );
}

function exif({ orientation, gps }: { orientation?: number; gps?: boolean }): Uint8Array {
  const entries: number[][] = [];
  const entryCount = (orientation !== undefined ? 1 : 0) + (gps ? 1 : 0);
  const gpsOffset = 8 + 2 + entryCount * 12 + 4;
  if (orientation !== undefined) {
    entries.push([0x12, 0x01, 3, 0, 1, 0, 0, 0, orientation, 0, 0, 0]);
  }
  if (gps) {
    entries.push([0x25, 0x88, 4, 0, 1, 0, 0, 0, gpsOffset & 0xff, gpsOffset >> 8, 0, 0]);
  }
  const ifd0 = [entryCount, 0, ...entries.flat(), 0, 0, 0, 0];
  const gpsIfd = gps ? [0, 0, 0, 0, 0, 0] : [];
  return concat(
    bytes("Exif\0\0"),
    bytes("II*\0"),
    Uint8Array.of(8, 0, 0, 0),
    Uint8Array.from(ifd0),
    Uint8Array.from(gpsIfd),
  );
}

function u32(n: number): Uint8Array {
  return Uint8Array.of((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);
}

function chunk(type: string, data: Uint8Array | number = 0): Uint8Array {
  const body = typeof data === "number" ? new Uint8Array(data) : data;
  return concat(u32(body.length), bytes(type), body, u32(0));
}

function png(...chunks: Uint8Array[]): Uint8Array {
  return concat(Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a), ...chunks);
}

function chunkTypes(file: Uint8Array): string[] {
  const types: string[] = [];
  let at = 8;
  while (at + 8 <= file.length) {
    const len = ((file[at] << 24) | (file[at + 1] << 16) | (file[at + 2] << 8) | file[at + 3]) >>> 0;
    types.push(text(file.slice(at + 4, at + 8)));
    at += 12 + len;
  }
  return types;
}

const ICC = segment(0xffe2, bytes("ICC_PROFILE\0\x01\x01profile"));

describe("imageMetadata", () => {
  it("removes EXIF, XMP and IPTC from a JPEG but keeps the colour profile and image data", () => {
    const input = jpeg(
      segment(0xffe0, bytes("JFIF\0")),
      segment(0xffe1, exif({ orientation: 6, gps: true })),
      segment(0xffe1, bytes("http://ns.adobe.com/xap/1.0/\0<x/>")),
      segment(0xffed, bytes("Photoshop 3.0\0")),
      ICC,
    );
    const out = stripJpegMetadata(input);
    expect(text(out)).not.toContain("Exif");
    expect(text(out)).not.toContain("ns.adobe.com");
    expect(text(out)).not.toContain("Photoshop");
    expect(text(out)).toContain("ICC_PROFILE");
    expect(Array.from(out.slice(-6))).toEqual(Array.from(input.slice(-6)));
    expect(stripJpegMetadata(out)).toEqual(out);
  });

  it("reads the orientation and the GPS block", () => {
    const photo = jpeg(segment(0xffe1, exif({ orientation: 6, gps: true })));
    expect(jpegOrientation(photo)).toBe(6);
    expect(hasGpsData(photo)).toBe(true);
    expect(jpegOrientation(jpeg())).toBe(1);
    expect(hasGpsData(jpeg(segment(0xffe1, exif({ orientation: 1 }))))).toBe(false);
    expect(hasGpsData(stripJpegMetadata(photo))).toBe(false);
  });

  it("removes text and EXIF chunks from a PNG", () => {
    const input = png(
      chunk("IHDR", 13),
      chunk("eXIf", exif({ gps: true }).slice(6)),
      chunk("tEXt", bytes("Author\0x")),
      chunk("iTXt"),
      chunk("zTXt"),
      chunk("IDAT", 4),
      chunk("IEND"),
    );
    expect(hasGpsData(input)).toBe(true);
    expect(chunkTypes(stripPngMetadata(input))).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("returns other bytes unchanged", () => {
    const gif = bytes("GIF89a....");
    expect(stripJpegMetadata(gif)).toEqual(gif);
    expect(stripPngMetadata(gif)).toEqual(gif);
    expect(hasGpsData(gif)).toBe(false);
  });

  it("does not throw on truncated input", () => {
    const photo = jpeg(segment(0xffe1, exif({ orientation: 6, gps: true })));
    const cut = photo.slice(0, 12);
    expect(() => stripJpegMetadata(cut)).not.toThrow();
    expect(jpegOrientation(cut)).toBe(1);
    expect(hasGpsData(cut)).toBe(false);
    const pic = png(chunk("IHDR", 13), chunk("tEXt", 10));
    const cutPng = pic.slice(0, pic.length - 5);
    expect(stripPngMetadata(cutPng)).toEqual(cutPng);
    expect(hasGpsData(cutPng)).toBe(false);
  });
});
