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

const SOI = Uint8Array.of(0xff, 0xd8);
const EOI = Uint8Array.of(0xff, 0xd9);

function jpeg(...segments: Uint8Array[]): Uint8Array {
  return concat(
    SOI,
    ...segments,
    Uint8Array.of(0xff, 0xda, 0, 8, 1, 2, 3, 4, 5, 6),
    Uint8Array.of(7, 8, 9),
    EOI,
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

function exifBigEndian({ orientation, gps }: { orientation: number; gps: boolean }): Uint8Array {
  const entryCount = 1 + (gps ? 1 : 0);
  const gpsOffset = 8 + 2 + entryCount * 12 + 4;
  const entries = [[0x01, 0x12, 0, 3, 0, 0, 0, 1, 0, orientation, 0, 0]];
  if (gps) entries.push([0x88, 0x25, 0, 4, 0, 0, 0, 1, 0, 0, gpsOffset >> 8, gpsOffset & 0xff]);
  return concat(
    bytes("Exif\0\0"),
    bytes("MM\0*"),
    Uint8Array.of(0, 0, 0, 8),
    Uint8Array.from([0, entryCount, ...entries.flat(), 0, 0, 0, 0]),
    Uint8Array.from(gps ? [0, 0, 0, 0, 0, 0] : []),
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

const JFIF = segment(0xffe0, concat(bytes("JFIF\0"), Uint8Array.of(1, 1, 1, 0, 72, 0, 72, 0, 0)));
const ICC = segment(0xffe2, bytes("ICC_PROFILE\0\x01\x01profile"));
const ADOBE = segment(0xffee, concat(bytes("Adobe"), Uint8Array.of(0, 100, 0, 0, 0, 0, 1)));
const DQT = segment(0xffdb, Uint8Array.of(0, 1, 2, 3));
const SOF2 = segment(0xffc2, Uint8Array.of(8, 0, 16, 0, 16, 1, 1, 0x11, 0));
const DHT = segment(0xffc4, Uint8Array.of(0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 5));

describe("stripJpegMetadata", () => {
  it("removes EXIF, XMP and IPTC from a JPEG but keeps the colour profile and image data", () => {
    const input = jpeg(
      JFIF,
      segment(0xffe1, exif({ orientation: 6, gps: true })),
      segment(0xffe1, bytes("http://ns.adobe.com/xap/1.0/\0<x/>")),
      segment(0xffed, bytes("Photoshop 3.0\0")),
      ICC,
    );
    const out = stripJpegMetadata(input)!;
    expect(text(out)).not.toContain("Exif");
    expect(text(out)).not.toContain("ns.adobe.com");
    expect(text(out)).not.toContain("Photoshop");
    expect(text(out)).toContain("ICC_PROFILE");
    expect(out).toEqual(jpeg(JFIF, ICC));
    expect(stripJpegMetadata(out)).toEqual(out);
  });

  it("keeps the segments a decoder needs byte-identical", () => {
    const clean = jpeg(JFIF, DQT, SOF2, DHT, segment(0xffdd, Uint8Array.of(0, 4)), ICC, ADOBE);
    expect(stripJpegMetadata(clean)).toEqual(clean);
  });

  it("drops everything after the end of the image", () => {
    const clean = jpeg(JFIF);
    const trailer = concat(SOI, bytes("MPF secondary image"), new Uint8Array(1024).fill(0x41), EOI);
    expect(stripJpegMetadata(concat(clean, trailer))).toEqual(clean);
  });

  it("drops APP11, MPF, the other APP segments and comments", () => {
    const input = jpeg(
      JFIF,
      segment(0xffe2, bytes("MPF\0II*\0")),
      segment(0xffe3, bytes("meta")),
      segment(0xffeb, bytes("JP\0\0jumbc2pa")),
      segment(0xffef, bytes("vendor")),
      segment(0xfffe, bytes("Shot on a phone")),
      ICC,
    );
    expect(stripJpegMetadata(input)).toEqual(jpeg(JFIF, ICC));
  });

  it("keeps every scan of a progressive JPEG byte-identical", () => {
    const sos = segment(0xffda, Uint8Array.of(1, 1, 0, 0, 63, 0));
    const scan1 = Uint8Array.of(1, 0xff, 0x00, 2, 0xff, 0xd0, 3, 0xff, 0xd1, 4);
    const scan2 = Uint8Array.of(5, 0xff, 0xd7, 6, 0xff, 0x00);
    const clean = concat(SOI, DQT, SOF2, DHT, sos, scan1, DHT, sos, scan2, EOI);
    expect(stripJpegMetadata(clean)).toEqual(clean);
    const tagged = concat(SOI, segment(0xffe1, exif({ gps: true })), DQT, SOF2, DHT, sos, scan1, DHT, sos, scan2, EOI);
    expect(stripJpegMetadata(tagged)).toEqual(clean);
  });

  it("drops the thumbnail inside the JFIF header", () => {
    const withThumb = segment(0xffe0, concat(bytes("JFIF\0"), Uint8Array.of(1, 1, 1, 0, 72, 0, 72, 1, 1, 9, 9, 9)));
    expect(stripJpegMetadata(jpeg(withThumb))).toEqual(jpeg(JFIF));
  });

  it("gives up on input it cannot follow to the end", () => {
    const photo = jpeg(segment(0xffe1, exif({ orientation: 6, gps: true })));
    expect(stripJpegMetadata(photo.slice(0, 12))).toBeNull();
    expect(stripJpegMetadata(photo.slice(0, photo.length - 2))).toBeNull();
    expect(stripJpegMetadata(concat(SOI, DQT, EOI))).toBeNull();
    expect(stripJpegMetadata(concat(SOI, Uint8Array.of(0xff, 0xdb, 0, 1), EOI))).toBeNull();
    expect(stripJpegMetadata(concat(SOI, Uint8Array.of(0x12, 0x34), EOI))).toBeNull();
    expect(stripJpegMetadata(bytes("GIF89a...."))).toBeNull();
  });
});

describe("stripPngMetadata", () => {
  it("removes text, EXIF, time and private chunks from a PNG", () => {
    const input = png(
      chunk("IHDR", 13),
      chunk("eXIf", exif({ gps: true }).slice(6)),
      chunk("tEXt", bytes("Author\0x")),
      chunk("iTXt"),
      chunk("zTXt"),
      chunk("tIME", 7),
      chunk("iDOT", 28),
      chunk("IDAT", 4),
      chunk("IEND"),
    );
    expect(hasGpsData(input)).toBe(true);
    expect(chunkTypes(stripPngMetadata(input)!)).toEqual(["IHDR", "IDAT", "IEND"]);
  });

  it("keeps the chunks that affect rendering byte-identical", () => {
    const clean = png(
      chunk("IHDR", 13),
      chunk("gAMA", 4),
      chunk("cHRM", 32),
      chunk("sRGB", 1),
      chunk("iCCP", 12),
      chunk("sBIT", 3),
      chunk("PLTE", 6),
      chunk("tRNS", 2),
      chunk("bKGD", 1),
      chunk("pHYs", 9),
      chunk("acTL", 8),
      chunk("fcTL", 26),
      chunk("IDAT", 4),
      chunk("fcTL", 26),
      chunk("fdAT", 8),
      chunk("IEND"),
    );
    expect(stripPngMetadata(clean)).toEqual(clean);
  });

  it("drops everything after IEND", () => {
    const clean = png(chunk("IHDR", 13), chunk("IDAT", 4), chunk("IEND"));
    const trailer = concat(chunk("IDAT", 64), chunk("tEXt", bytes("uncropped")), bytes("junk"));
    expect(stripPngMetadata(concat(clean, trailer))).toEqual(clean);
  });

  it("gives up on input it cannot follow to the end", () => {
    const pic = png(chunk("IHDR", 13), chunk("tEXt", 10), chunk("IDAT", 4), chunk("IEND"));
    expect(stripPngMetadata(pic.slice(0, pic.length - 5))).toBeNull();
    expect(stripPngMetadata(png(chunk("IHDR", 13), chunk("IDAT", 4)))).toBeNull();
    expect(stripPngMetadata(bytes("GIF89a...."))).toBeNull();
  });
});

describe("EXIF readers", () => {
  it("reads the orientation and the GPS block", () => {
    const photo = jpeg(segment(0xffe1, exif({ orientation: 6, gps: true })));
    expect(jpegOrientation(photo)).toBe(6);
    expect(hasGpsData(photo)).toBe(true);
    expect(jpegOrientation(jpeg())).toBe(1);
    expect(hasGpsData(jpeg(segment(0xffe1, exif({ orientation: 1 }))))).toBe(false);
    expect(hasGpsData(stripJpegMetadata(photo)!)).toBe(false);
  });

  it("reads big-endian EXIF as iPhones write it", () => {
    const photo = jpeg(segment(0xffe1, exifBigEndian({ orientation: 6, gps: true })));
    expect(jpegOrientation(photo)).toBe(6);
    expect(hasGpsData(photo)).toBe(true);
    expect(hasGpsData(jpeg(segment(0xffe1, exifBigEndian({ orientation: 8, gps: false }))))).toBe(false);
    expect(jpegOrientation(jpeg(segment(0xffe1, exifBigEndian({ orientation: 8, gps: false }))))).toBe(8);
  });

  it("answers safely for other and truncated input", () => {
    const photo = jpeg(segment(0xffe1, exif({ orientation: 6, gps: true })));
    const cut = photo.slice(0, 12);
    expect(jpegOrientation(cut)).toBe(1);
    expect(hasGpsData(cut)).toBe(false);
    const cutPng = png(chunk("IHDR", 13), chunk("tEXt", 10)).slice(0, -5);
    expect(hasGpsData(cutPng)).toBe(false);
    expect(hasGpsData(bytes("GIF89a...."))).toBe(false);
  });
});
