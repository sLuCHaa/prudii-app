import { describe, it, expect } from "vitest";
import { composeTarget } from "./composePlacement";

describe("composeTarget", () => {
  it("opens a window by default", () => {
    expect(composeTarget(false, false)).toBe("window");
  });

  it("docks the compose when the user chose that", () => {
    expect(composeTarget(true, false)).toBe("dock");
  });

  it("opens a second compose as a window, so the docked one is not replaced", () => {
    expect(composeTarget(true, true)).toBe("window");
  });

  it("never docks while the setting is off, even with a compose left in the dock", () => {
    expect(composeTarget(false, true)).toBe("window");
  });
});
