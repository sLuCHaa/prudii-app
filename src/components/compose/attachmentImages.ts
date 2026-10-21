import type { PreparedImage } from "../../lib/imagePrep";

export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const MAX_IMAGE_INPUT_BYTES = 100 * 1024 * 1024;

export interface AttachmentBytes {
  data: string;
  type: string;
  name: string;
  size: number;
}

export interface ImageNotes {
  shrunkFrom?: number | null;
  locationRemoved?: boolean;
  original?: AttachmentBytes | null;
}

// Photos are shrunk before they count against the attachment limit, so they may be read at a larger size.
export function tooLargeToRead(file: { size: number; type: string }): boolean {
  const limit = file.type.startsWith("image/") ? MAX_IMAGE_INPUT_BYTES : MAX_ATTACHMENT_BYTES;
  return file.size > limit;
}

export function withPrepared<T extends AttachmentBytes>(att: T, prepared: PreparedImage): T & ImageNotes {
  return {
    ...att,
    data: prepared.data,
    type: prepared.type,
    name: prepared.name,
    size: prepared.size,
    locationRemoved: prepared.locationRemoved,
    shrunkFrom: prepared.shrunkFrom,
    original: prepared.original && prepared.original.size <= MAX_ATTACHMENT_BYTES ? prepared.original : null,
  };
}

export function toOriginal<T extends AttachmentBytes & ImageNotes>(att: T): T {
  if (!att.original) return att;
  const { shrunkFrom: _shrunkFrom, original, ...rest } = att;
  return { ...rest, ...original } as unknown as T;
}
