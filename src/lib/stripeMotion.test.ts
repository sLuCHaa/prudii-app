import { describe, expect, it } from "vitest";
import { stripeChange } from "./stripeMotion";

describe("stripeChange", () => {
  it("does nothing on mount", () => {
    expect(stripeChange(null, { unread: false, starred: true })).toEqual({ read: null, star: null });
  });

  it("shrinks to a dot when read", () => {
    expect(stripeChange({ unread: true, starred: false }, { unread: false, starred: false }).read).toBe("out");
  });

  it("grows back when marked unread", () => {
    expect(stripeChange({ unread: false, starred: false }, { unread: true, starred: false }).read).toBe("in");
  });

  it("glows when starred and fades when unstarred", () => {
    expect(stripeChange({ unread: false, starred: false }, { unread: false, starred: true }).star).toBe("on");
    expect(stripeChange({ unread: false, starred: true }, { unread: false, starred: false }).star).toBe("off");
  });

  it("does nothing when nothing changed", () => {
    expect(stripeChange({ unread: true, starred: true }, { unread: true, starred: true })).toEqual({ read: null, star: null });
  });
});
