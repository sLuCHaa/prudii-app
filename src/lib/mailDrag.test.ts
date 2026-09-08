import { describe, it, expect } from "vitest";
import { isMailDrag, readMailDrag } from "./mailDrag";

// Minimal DataTransfer stub — jsdom's real one requires a live drag event to populate.
function makeDataTransfer(data: Record<string, string>): DataTransfer {
  return {
    types: Object.keys(data),
    getData: (format: string) => data[format] ?? "",
  } as unknown as DataTransfer;
}

describe("isMailDrag", () => {
  it("is true when the mail-id type is present", () => {
    expect(isMailDrag(makeDataTransfer({ "application/x-mail-id": "m1" }))).toBe(true);
  });

  it("is false for an unrelated drag (e.g. an OS file drop)", () => {
    expect(isMailDrag(makeDataTransfer({ Files: "" }))).toBe(false);
  });
});

describe("readMailDrag", () => {
  it("returns the mail and account id", () => {
    const dt = makeDataTransfer({ "application/x-mail-id": "m1", "application/x-mail-account-id": "a1" });
    expect(readMailDrag(dt)).toEqual({ mailId: "m1", accountId: "a1" });
  });

  it("returns null when there is no mail id", () => {
    expect(readMailDrag(makeDataTransfer({}))).toBeNull();
  });
});
