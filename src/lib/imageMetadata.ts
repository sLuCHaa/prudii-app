// Removes location and camera data from JPEG and PNG bytes without re-encoding,
// so the pixels stay byte-identical. Malformed input is never an error: the
// strip functions return it unchanged, the readers answer 1 / false.

const SOS = 0xda;
const APP1 = 0xe1;
const APP13 = 0xed;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PNG_DROPPED = new Set(["eXIf", "tEXt", "iTXt", "zTXt"]);
const EXIF_HEADER = "Exif\0\0";

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

export function stripJpegMetadata(bytes: Uint8Array): Uint8Array {
  if (!isJpeg(bytes)) return bytes;
  const kept: Uint8Array[] = [bytes.subarray(0, 2)];
  let at = 2;
  while (at + 2 <= bytes.length) {
    if (bytes[at] !== 0xff) return bytes;
    const marker = bytes[at + 1];
    if (marker === 0xff) {
      kept.push(bytes.subarray(at, at + 1));
      at++;
      continue;
    }
    if (marker === SOS) {
      kept.push(bytes.subarray(at));
      return join(kept);
    }
    if (at + 4 > bytes.length) return bytes;
    const len = (bytes[at + 2] << 8) | bytes[at + 3];
    if (len < 2 || at + 2 + len > bytes.length) return bytes;
    if (marker !== APP1 && marker !== APP13) kept.push(bytes.subarray(at, at + 2 + len));
    at += 2 + len;
  }
  return bytes;
}

export function stripPngMetadata(bytes: Uint8Array): Uint8Array {
  if (!isPng(bytes)) return bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  const kept: Uint8Array[] = [bytes.subarray(0, 8)];
  let at = 8;
  while (at < bytes.length) {
    if (at + 12 > bytes.length) return bytes;
    const len = view.getUint32(at);
    const end = at + 12 + len;
    if (end > bytes.length) return bytes;
    if (!PNG_DROPPED.has(ascii(bytes, at + 4, 4))) kept.push(bytes.subarray(at, end));
    at = end;
  }
  return join(kept);
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
