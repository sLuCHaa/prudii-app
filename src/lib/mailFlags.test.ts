import { describe, it, expect } from "vitest";
import { FLAG_ORDER, commonFlags, bulkFlagAction } from "./mailFlags";

describe("FLAG_ORDER", () => {
  it("lists every flag colour exactly once", () => {
    expect(FLAG_ORDER).toEqual(["red", "orange", "yellow", "green", "blue", "purple", "gray"]);
    expect(new Set(FLAG_ORDER).size).toBe(FLAG_ORDER.length);
  });
});

describe("commonFlags", () => {
  it("returns the flags carried by every mail", () => {
    expect(commonFlags([["red", "blue"], ["red", "green"]])).toEqual(["red"]);
  });

  it("returns nothing for an empty selection", () => {
    expect(commonFlags([])).toEqual([]);
  });

  it("ignores unknown flag values", () => {
    expect(commonFlags([["red", "chartreuse"], ["red", "chartreuse"]])).toEqual(["red"]);
  });

  it("keeps FLAG_ORDER rather than the mail's own order", () => {
    expect(commonFlags([["gray", "red"], ["red", "gray"]])).toEqual(["red", "gray"]);
  });
});

describe("bulkFlagAction", () => {
  it("clears a flag that every mail already carries", () => {
    expect(bulkFlagAction([["red"], ["red", "blue"]], "red")).toBe("clear");
  });

  it("sets a flag that only some mails carry", () => {
    expect(bulkFlagAction([["red"], ["blue"]], "red")).toBe("set");
  });

  it("sets a flag nobody carries", () => {
    expect(bulkFlagAction([[], []], "red")).toBe("set");
  });

  it("sets rather than clears for an empty selection", () => {
    expect(bulkFlagAction([], "red")).toBe("set");
  });
});
