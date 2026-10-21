import {
  hasGpsData,
  jpegOrientation,
  stripJpegMetadata,
  stripPngMetadata,
} from "./imageMetadata";

export const SHRINK_EDGE = 2560;
export const SHRINK_BYTES = 1.5 * 1024 * 1024;
export const TARGET_EDGE = 2048;

const SHRINK_QUALITY = 0.85;
const FULL_QUALITY = 0.92;

export interface ImagePlan {
  reencode: boolean;
  maxEdge: number;
  outputType: "image/jpeg" | "image/png";
  quality: number;
}

export interface PreparedImage {
  data: string;
  type: string;
  name: string;
  size: number;
  width: number;
  height: number;
  locationRemoved: boolean;
  shrunkFrom: number | null;
  original: { data: string; type: string; name: string; size: number } | null;
}

export function planImage(input: {
  type: string;
  size: number;
  width: number;
  height: number;
  orientation: number;
}): ImagePlan | null {
  const type = input.type.toLowerCase();
  const longEdge = Math.max(input.width, input.height);
  const tooBig = longEdge > SHRINK_EDGE || input.size > SHRINK_BYTES;
  if (type === "image/png") {
    const reencode = longEdge > SHRINK_EDGE;
    return { reencode, maxEdge: TARGET_EDGE, outputType: "image/png", quality: FULL_QUALITY };
  }
  if (type === "image/jpeg") {
    if (tooBig) {
      return { reencode: true, maxEdge: TARGET_EDGE, outputType: "image/jpeg", quality: SHRINK_QUALITY };
    }
    return {
      reencode: input.orientation > 1,
      maxEdge: TARGET_EDGE,
      outputType: "image/jpeg",
      quality: FULL_QUALITY,
    };
  }
  if (type === "image/webp" || type === "image/heic" || type === "image/heif") {
    return {
      reencode: true,
      maxEdge: TARGET_EDGE,
      outputType: "image/jpeg",
      quality: tooBig ? SHRINK_QUALITY : FULL_QUALITY,
    };
  }
  return null;
}

export function base64Size(b64: string): number {
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.floor((b64.length * 3) / 4) - padding;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function encode(
  bitmap: ImageBitmap,
  maxEdge: number,
  type: string,
  quality: number,
): Promise<{ data: string; size: number; width: number; height: number; scaled: boolean }> {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("no canvas context");
  if (type === "image/jpeg") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  if (!blob || blob.type !== type) throw new Error("encode failed");
  return { data: await blobToBase64(blob), size: blob.size, width, height, scaled: scale < 1 };
}

function renameFor(name: string, type: string, outputType: string): string {
  if (type === "image/jpeg" || outputType !== "image/jpeg") return name;
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}.jpg`;
}

export async function prepareImage(file: File): Promise<PreparedImage | null> {
  try {
    const type = file.type.toLowerCase();
    const bytes = new Uint8Array(await file.arrayBuffer());
    const locationRemoved = hasGpsData(bytes);
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      const orientation = type === "image/jpeg" ? jpegOrientation(bytes) : 1;
      const plan = planImage({
        type,
        size: file.size,
        width: bitmap.width,
        height: bitmap.height,
        orientation,
      });
      if (!plan) return null;

      const isLossless = type === "image/jpeg" || type === "image/png";
      const stripped = !isLossless
        ? null
        : type === "image/jpeg"
          ? stripJpegMetadata(bytes)
          : stripPngMetadata(bytes);
      const strippedClean = stripped !== null && !hasGpsData(stripped);
      const outputName = renameFor(file.name, type, plan.outputType);

      const fromStripped = (): PreparedImage => ({
        data: bytesToBase64(stripped as Uint8Array),
        type,
        name: file.name,
        size: (stripped as Uint8Array).length,
        width: bitmap.width,
        height: bitmap.height,
        locationRemoved,
        shrunkFrom: null,
        original: null,
      });

      if (!plan.reencode && strippedClean) return fromStripped();

      const quality = plan.reencode ? plan.quality : FULL_QUALITY;
      const out = await encode(bitmap, plan.maxEdge, plan.outputType, quality);
      if (strippedClean && orientation === 1 && out.size >= (stripped as Uint8Array).length) {
        return fromStripped();
      }

      const shrunk = out.scaled || quality === SHRINK_QUALITY;
      let original: PreparedImage["original"] = null;
      if (shrunk) {
        try {
          if (strippedClean && orientation === 1) {
            original = {
              data: bytesToBase64(stripped as Uint8Array),
              type,
              name: file.name,
              size: (stripped as Uint8Array).length,
            };
          } else {
            const full = await encode(bitmap, Infinity, plan.outputType, FULL_QUALITY);
            original = { data: full.data, type: plan.outputType, name: outputName, size: full.size };
          }
        } catch {
          original = null;
        }
      }

      return {
        data: out.data,
        type: plan.outputType,
        name: outputName,
        size: out.size,
        width: out.width,
        height: out.height,
        locationRemoved,
        shrunkFrom: shrunk ? file.size : null,
        original,
      };
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}
