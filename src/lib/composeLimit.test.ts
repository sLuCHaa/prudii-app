import { describe, it, expect } from "vitest";
import { MAX_COMPOSE_WINDOWS, composeLabels, oldestComposeLabel } from "./composeLimit";

describe("composeLabels", () => {
  it("keeps only labels openComposeWindow could have created", () => {
    expect(composeLabels(["main", "compose-1700000000000-1", "compose", "settings"])).toEqual([
      "compose-1700000000000-1",
    ]);
  });

  it("ignores look-alikes that are not compose windows", () => {
    expect(composeLabels(["compose-abc-1", "compose-1-", "recompose-1-1"])).toEqual([]);
  });
});

describe("oldestComposeLabel", () => {
  it("returns null when nothing is open", () => {
    expect(oldestComposeLabel(["main"])).toBeNull();
  });

  it("picks the earliest timestamp, not the lexicographically smallest", () => {
    // "compose-9..." sorts before "compose-10..." as text but is the newer window.
    expect(oldestComposeLabel(["compose-9000000000000-2", "compose-10000000000-1"])).toBe(
      "compose-10000000000-1",
    );
  });

  it("falls back to the lower counter when two windows share a timestamp", () => {
    expect(oldestComposeLabel(["compose-1700000000000-7", "compose-1700000000000-3"])).toBe(
      "compose-1700000000000-3",
    );
  });

  it("ignores the main window", () => {
    expect(oldestComposeLabel(["main", "compose-1700000000000-1"])).toBe("compose-1700000000000-1");
  });
});

describe("MAX_COMPOSE_WINDOWS", () => {
  it("is five", () => {
    expect(MAX_COMPOSE_WINDOWS).toBe(5);
  });
});
