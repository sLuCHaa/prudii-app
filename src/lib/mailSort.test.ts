import { describe, it, expect } from "vitest";
import { parseMailSort, nextSort, isDateSort, sortField, sortDirection, absenceMeansMoved } from "./mailSort";

describe("parseMailSort", () => {
  it("accepts the six known values", () => {
    for (const v of ["date_desc", "date_asc", "correspondent_asc", "correspondent_desc", "subject_asc", "subject_desc"]) {
      expect(parseMailSort(v)).toBe(v);
    }
  });

  it("falls back to newest first", () => {
    expect(parseMailSort(undefined)).toBe("date_desc");
    expect(parseMailSort("")).toBe("date_desc");
    expect(parseMailSort("size_asc")).toBe("date_desc");
    expect(parseMailSort("date_sideways")).toBe("date_desc");
  });
});

describe("nextSort", () => {
  it("picks each field's natural direction when switching", () => {
    expect(nextSort("subject_desc", "date")).toBe("date_desc");
    expect(nextSort("date_desc", "subject")).toBe("subject_asc");
    expect(nextSort("date_asc", "correspondent")).toBe("correspondent_asc");
  });

  it("flips the direction of the active field", () => {
    expect(nextSort("date_desc", "date")).toBe("date_asc");
    expect(nextSort("subject_asc", "subject")).toBe("subject_desc");
  });
});

describe("absenceMeansMoved", () => {
  it("only trusts a missing open mail under newest-first", () => {
    expect(absenceMeansMoved("date_desc")).toBe(true);
    for (const sort of ["date_asc", "correspondent_asc", "correspondent_desc", "subject_asc", "subject_desc"] as const) {
      expect(absenceMeansMoved(sort)).toBe(false);
    }
  });
});

describe("helpers", () => {
  it("split a sort into field and direction", () => {
    expect(sortField("correspondent_desc")).toBe("correspondent");
    expect(sortDirection("correspondent_desc")).toBe("desc");
    expect(isDateSort("date_asc")).toBe(true);
    expect(isDateSort("subject_asc")).toBe(false);
  });
});
