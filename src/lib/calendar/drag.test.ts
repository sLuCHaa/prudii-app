import { describe, it, expect } from "vitest";
import { atMinutes, minutesFromOffset, moveDueToDay, resizedEnd, shiftAllDay, shiftTimed, snapMinutes } from "./drag";

describe("drag maths", () => {
  it("snaps to quarter hours inside the day", () => {
    expect(snapMinutes(52)).toBe(45);
    expect(snapMinutes(53)).toBe(60);
    expect(snapMinutes(-10)).toBe(0);
    expect(snapMinutes(2000)).toBe(1440);
    expect(minutesFromOffset(96, 48)).toBe(120);
  });

  it("moves timed events keeping their duration", () => {
    const start = new Date(2026, 9, 15, 9, 0);
    const end = new Date(2026, 9, 15, 10, 30);
    const moved = shiftTimed(start, end, 1, 30);
    expect(moved.start.getTime()).toBe(new Date(2026, 9, 16, 9, 30).getTime());
    expect(moved.end.getTime()).toBe(new Date(2026, 9, 16, 11, 0).getTime());
    expect(atMinutes(new Date(2026, 9, 15, 13), 615).getTime()).toBe(new Date(2026, 9, 15, 10, 15).getTime());
  });

  it("never resizes below one snap", () => {
    const start = new Date(2026, 9, 15, 9, 0);
    expect(resizedEnd(start, new Date(2026, 9, 15), 540).getTime()).toBe(new Date(2026, 9, 15, 9, 15).getTime());
    expect(resizedEnd(start, new Date(2026, 9, 15), 660).getTime()).toBe(new Date(2026, 9, 15, 11, 0).getTime());
  });

  it("shifts multi-day all-day events keeping the exclusive end", () => {
    expect(shiftAllDay("2026-10-15", "2026-10-18", 2)).toEqual({ start: "2026-10-17", end: "2026-10-20" });
    expect(shiftAllDay("2026-10-31", "2026-11-01", 1)).toEqual({ start: "2026-11-01", end: "2026-11-02" });
  });

  it("keeps a task's time of day when it moves to another day", () => {
    const due = new Date(2026, 9, 15, 14, 30).toISOString();
    expect(new Date(moveDueToDay(due, new Date(2026, 9, 20))).getTime()).toBe(new Date(2026, 9, 20, 14, 30).getTime());
  });
});
