import { afterEach, describe, expect, it, vi } from "vitest";
import { checkMailboxCheckHintOnce, markMailboxCheckSeen } from "./achievements";

describe("checkMailboxCheckHintOnce", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
  });

  it("shows the inbox check hint once", () => {
    expect(checkMailboxCheckHintOnce()).toBe(true);
    expect(checkMailboxCheckHintOnce()).toBe(false);
  });

  it("skips the hint once the check was opened", () => {
    markMailboxCheckSeen();
    expect(checkMailboxCheckHintOnce()).toBe(false);
  });

  it("stays quiet when storage fails", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(checkMailboxCheckHintOnce()).toBe(false);
  });
});
