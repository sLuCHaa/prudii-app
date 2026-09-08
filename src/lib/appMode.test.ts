import { describe, it, expect } from "vitest";
import { resolveAppMode } from "./appMode";

describe("resolveAppMode", () => {
  it("defaults to the main window", () => {
    expect(resolveAppMode("")).toBe("main");
    expect(resolveAppMode("?foo=1")).toBe("main");
  });
  it("detects the compose window", () => {
    expect(resolveAppMode("?compose")).toBe("compose");
    expect(resolveAppMode("?compose=1&id=abc")).toBe("compose");
  });
  it("detects the backup window", () => {
    expect(resolveAppMode("?backup=true")).toBe("backup");
  });
});
