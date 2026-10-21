import { describe, expect, it } from "vitest";
import type { PreparedImage } from "../../lib/imagePrep";
import {
  MAX_ATTACHMENT_BYTES,
  MAX_IMAGE_INPUT_BYTES,
  toOriginal,
  tooLargeToRead,
  withPrepared,
} from "./attachmentImages";

const prepared: PreparedImage = {
  data: "small",
  type: "image/jpeg",
  name: "photo.jpg",
  size: 1000,
  width: 100,
  height: 80,
  locationRemoved: true,
  shrunkFrom: 5000,
  original: { data: "big", type: "image/jpeg", name: "photo.jpg", size: 5000 },
};

describe("tooLargeToRead", () => {
  it("lets images through up to the image limit", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(25 * 1024 * 1024);
    expect(MAX_IMAGE_INPUT_BYTES).toBe(100 * 1024 * 1024);
    expect(tooLargeToRead({ size: 30e6, type: "image/jpeg" })).toBe(false);
    expect(tooLargeToRead({ size: 101 * 1024 * 1024, type: "image/png" })).toBe(true);
  });

  it("holds other files to the attachment limit", () => {
    expect(tooLargeToRead({ size: 30e6, type: "application/pdf" })).toBe(true);
    expect(tooLargeToRead({ size: 1e6, type: "application/pdf" })).toBe(false);
  });
});

describe("withPrepared", () => {
  it("takes over the bytes and the notes", () => {
    const att = { id: "a", data: "", type: "image/heic", name: "photo.jpg", size: 9000 };
    const out = withPrepared(att, prepared);
    expect(out).toMatchObject({
      id: "a",
      data: "small",
      type: "image/jpeg",
      name: "photo.jpg",
      size: 1000,
      locationRemoved: true,
      shrunkFrom: 5000,
      original: prepared.original,
    });
  });
});

describe("toOriginal", () => {
  it("swaps to the original and drops the shrink notes", () => {
    const att = withPrepared({ id: "a", data: "", type: "x", name: "x", size: 1 }, prepared);
    const out = toOriginal(att);
    expect(out.data).toBe("big");
    expect(out.size).toBe(5000);
    expect(out.id).toBe("a");
    expect(out.shrunkFrom).toBeUndefined();
    expect(out.original).toBeUndefined();
    expect(out.locationRemoved).toBe(true);
  });

  it("leaves an attachment without an original alone", () => {
    const att = { data: "d", type: "t", name: "n", size: 1, original: null };
    expect(toOriginal(att)).toBe(att);
  });
});
