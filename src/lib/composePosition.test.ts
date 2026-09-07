import { describe, it, expect } from "vitest";
import { pickComposePosition } from "./composePosition";

const mon = [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: 1920, y: 0, width: 1920, height: 1080 }];
const size = { w: 740, h: 680 };

describe("pickComposePosition", () => {
  it("uses the saved position when it is on a monitor, plus the cascade", () => {
    expect(pickComposePosition({ x: 100, y: 100 }, mon, 25, size)).toEqual({ x: 125, y: 125 });
    expect(pickComposePosition({ x: 2000, y: 50 }, mon, 0, size)).toEqual({ x: 2000, y: 50 });
  });
  it("clamps so the window stays inside its monitor", () => {
    expect(pickComposePosition({ x: 1500, y: 800 }, mon, 0, size)).toEqual({ x: 1180, y: 360 });
  });
  it("rejects positions off every monitor or without monitors", () => {
    expect(pickComposePosition({ x: 5000, y: 5000 }, mon, 0, size)).toBeNull();
    expect(pickComposePosition({ x: 100, y: 100 }, [], 0, size)).toBeNull();
    expect(pickComposePosition(null, mon, 0, size)).toBeNull();
  });
});
