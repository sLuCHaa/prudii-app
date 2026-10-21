// Allowlists, so data a format adds later (or hides after the image) never slips through.

const SOS = 0xda;
const EOI = 0xd9;
const APP0 = 0xe0;
const APP1 = 0xe1;
const APP2 = 0xe2;
const APP14 = 0xee;
const APP15 = 0xef;
const COM = 0xfe;
const JPEG_RENDER_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcc, 0xcd, 0xce, 0xcf, 0xdb, 0xdc, 0xdd,
]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_KEPT = new Set([
  "IHDR", "PLTE", "IDAT", "IEND", "tRNS", "gAMA", "cHRM", "sRGB", "iCCP", "sBIT", "bKGD", "pHYs", "acTL", "fcTL", "fdAT",
]);
const EXIF_HEADER = "Exif\0\0";
const DROP = new Uint8Array(0);

interface ExifInfo {
  orientation: number;
  gps: boolean;
}

function isJpeg(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0xff && b[1] === 0xd8;
}

function isPng(b: Uint8Array): boolean {
  return b.length >= 8 && PNG_SIGNATURE.every((v, i) => b[i] === v);
}

function startsWith(b: Uint8Array, at: number, s: string): boolean {
  if (at + s.length > b.length) return false;
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false;
  return true;
}

function ascii(b: Uint8Array, at: number, n: number): string {
  let s = "";
  for (let i = at; i < at + n; i++) s += String.fromCharCode(b[i]);
  return s;
}

function readExif(b: Uint8Array, start: number, end: number): ExifInfo | null {
  if (end - start < 8) return null;
  const little = b[start] === 0x49 && b[start + 1] === 0x49;
  if (!little && !(b[start] === 0x4d && b[start + 1] === 0x4d)) return null;
  const view = new DataView(b.buffer, b.byteOffset + start, end - start);
  if (view.getUint16(2, little) !== 42) return null;
  const ifd = view.getUint32(4, little);
  if (ifd + 2 > view.byteLength) return null;
  const count = view.getUint16(ifd, little);
  const info: ExifInfo = { orientation: 1, gps: false };
  for (let i = 0; i < count; i++) {
    const at = ifd + 2 + i * 12;
    if (at + 12 > view.byteLength) break;
    const tag = view.getUint16(at, little);
    if (tag === 0x0112) {
      const value = view.getUint16(at + 8, little);
      if (value >= 1 && value <= 8) info.orientation = value;
    } else if (tag === 0x8825) {
      info.gps = true;
    }
  }
  return info;
}

function jpegExif(b: Uint8Array): ExifInfo | null {
  if (!isJpeg(b)) return null;
  let at = 2;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === SOS) return null;
    const len = (b[at + 2] << 8) | b[at + 3];
    if (len < 2 || at + 2 + len > b.length) return null;
    if (marker === APP1 && startsWith(b, at + 4, EXIF_HEADER)) {
      return readExif(b, at + 4 + EXIF_HEADER.length, at + 2 + len);
    }
    at += 2 + len;
  }
  return null;
}

function pngExif(b: Uint8Array): ExifInfo | null {
  if (!isPng(b)) return null;
  const view = new DataView(b.buffer, b.byteOffset, b.length);
  let at = 8;
  while (at + 12 <= b.length) {
    const len = view.getUint32(at);
    if (at + 12 + len > b.length) return null;
    if (ascii(b, at + 4, 4) === "eXIf") return readExif(b, at + 8, at + 8 + len);
    at += 12 + len;
  }
  return null;
}

// Entropy-coded data runs until a marker other than a stuffed 0xFF00 or a restart marker.
function scanEnd(b: Uint8Array, from: number): number {
  for (let i = from; i + 1 < b.length; i++) {
    if (b[i] !== 0xff) continue;
    const next = b[i + 1];
    if (next !== 0x00 && (next < 0xd0 || next > 0xd7)) return i;
    i++;
  }
  return -1;
}

function jfifWithoutThumbnail(b: Uint8Array, at: number): Uint8Array {
  const head = b.slice(at, at + 18);
  head[2] = 0;
  head[3] = 16;
  head[16] = 0;
  head[17] = 0;
  return head;
}

function jpegSegment(b: Uint8Array, at: number, end: number): Uint8Array | null {
  const marker = b[at + 1];
  if (JPEG_RENDER_MARKERS.has(marker)) return b.subarray(at, end);
  if (marker === APP0) return end - at >= 18 && startsWith(b, at + 4, "JFIF\0") ? jfifWithoutThumbnail(b, at) : DROP;
  if (marker === APP2) return startsWith(b, at + 4, "ICC_PROFILE\0") ? b.subarray(at, end) : DROP;
  if (marker === APP14) return startsWith(b, at + 4, "Adobe") ? b.subarray(at, end) : DROP;
  if ((marker >= APP0 && marker <= APP15) || marker === COM) return DROP;
  return null;
}

export function stripJpegMetadata(bytes: Uint8Array): Uint8Array | null {
  if (!isJpeg(bytes)) return null;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let scans = 0;
  let at = 2;
  while (at + 2 <= bytes.length) {
    if (bytes[at] !== 0xff) return null;
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      at++;
      continue;
    }
    if (marker === EOI) {
      if (scans === 0) return null;
      kept.push(bytes.subarray(at, at + 2));
      return join(kept);
    }
    if (at + 4 > bytes.length) return null;
    const end = at + 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
    if (end < at + 4 || end > bytes.length) return null;
    if (marker === SOS) {
      const stop = scanEnd(bytes, end);
      if (stop < 0) return null;
      kept.push(bytes.subarray(at, stop));
      scans++;
      at = stop;
      continue;
    }
    const segment = jpegSegment(bytes, at, end);
    if (!segment) return null;
    kept.push(segment);
    at = end;
  }
  return null;
}

export function stripPngMetadata(bytes: Uint8Array): Uint8Array | null {
  if (!isPng(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  while (at + 12 <= bytes.length) {
    const end = at + 12 + view.getUint32(at);
    if (end > bytes.length) return null;
    const type = ascii(bytes, at + 4, 4);
    if (PNG_KEPT.has(type)) kept.push(bytes.subarray(at, end));
    if (type === "IEND") return join(kept);
    at = end;
  }
  return null;
}

export function jpegOrientation(bytes: Uint8Array): number {
  try {
    return jpegExif(bytes)?.orientation ?? 1;
  } catch {
    return 1;
  }
}

export function hasGpsData(bytes: Uint8Array): boolean {
  try {
    return (isJpeg(bytes) ? jpegExif(bytes) : pngExif(bytes))?.gps ?? false;
  } catch {
    return false;
  }
}

function join(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
