import { describe, it, expect } from "vitest";
import { revealLabelKey } from "./attachmentActions";

describe("revealLabelKey", () => {
  it("names the platform file manager", () => {
    expect(revealLabelKey({ isMac: true, isWindows: false })).toBe("attachments.reveal.finder");
    expect(revealLabelKey({ isMac: false, isWindows: true })).toBe("attachments.reveal.explorer");
    expect(revealLabelKey({ isMac: false, isWindows: false })).toBe("attachments.reveal.fileManager");
  });
});
