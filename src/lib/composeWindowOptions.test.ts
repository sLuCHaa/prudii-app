import { describe, it, expect } from "vitest";
import { backgroundFor, composeWindowOptions } from "./composeWindowOptions";

const GEOMETRY = { w: 740, h: 680, x: 120, y: 90 };

describe("composeWindowOptions", () => {
  it("makes the window transparent on macOS, so the webview cannot paint its white default before the content", () => {
    expect(composeWindowOptions(true, GEOMETRY, true).transparent).toBe(true);
  });

  it("keeps the window opaque on the other platforms", () => {
    expect(composeWindowOptions(true, GEOMETRY, false).transparent).toBeUndefined();
  });

  it("gives the native window the background of the theme", () => {
    expect(composeWindowOptions(true, GEOMETRY, true).backgroundColor).toEqual(backgroundFor(true));
    expect(composeWindowOptions(false, GEOMETRY, false).backgroundColor).toEqual(backgroundFor(false));
    expect(backgroundFor(true)).not.toEqual(backgroundFor(false));
  });

  it("creates the window hidden", () => {
    expect(composeWindowOptions(true, GEOMETRY, true).visible).toBe(false);
    expect(composeWindowOptions(true, GEOMETRY, false).visible).toBe(false);
  });

  it("uses the native frame with an overlay title bar on macOS and none elsewhere", () => {
    const mac = composeWindowOptions(true, GEOMETRY, true);
    expect(mac.decorations).toBe(true);
    expect(mac.titleBarStyle).toBe("overlay");
    expect(composeWindowOptions(true, GEOMETRY, false).decorations).toBe(false);
  });

  it("places the window where the geometry says and centres it without a position", () => {
    const placed = composeWindowOptions(true, GEOMETRY, false);
    expect([placed.width, placed.height, placed.x, placed.y, placed.center]).toEqual([740, 680, 120, 90, false]);
    expect(composeWindowOptions(true, { w: 740, h: 680 }, false).center).toBe(true);
  });
});
