import { describe, it, expect } from "vitest";
import { enUS } from "date-fns/locale";
import {
  daySegment, isLaneEvent, isoDate, monthGrid, occurrenceRange, occursOnDay, parseIsoDate, shiftAnchor, spanInDays,
  viewDays, viewTitle, visibleRange, weekNumber,
} from "./dates";
import type { Occurrence } from "../../types/calendar";

function occ(start: string, end: string, allDay = false): Occurrence {
  return {
    event_id: "e", calendar_id: "c", color: "#000", title: "T", location: "", description: "", all_day: allDay,
    start, end, occurrence_key: start, is_recurring: false, is_override: false, status: "confirmed",
    my_partstat: null, is_organizer: false, has_attendees: false,
  };
}

const local = (y: number, m: number, d: number, h = 0, min = 0) => new Date(y, m - 1, d, h, min);

describe("monthGrid", () => {
  it("covers the month in whole weeks for each week start", () => {
    const monday = monthGrid(local(2026, 10, 15), 1);
    expect(monday).toHaveLength(5);
    expect(isoDate(monday[0][0])).toBe("2026-09-28");
    expect(isoDate(monday[4][6])).toBe("2026-11-01");
    const sunday = monthGrid(local(2026, 10, 15), 0);
    expect(isoDate(sunday[0][0])).toBe("2026-09-27");
    expect(monthGrid(local(2026, 2, 10), 0)).toHaveLength(4);
  });
});

describe("views", () => {
  it("lists the work week from the configured days", () => {
    expect(viewDays("workweek", local(2026, 10, 15), 1, [1, 2, 3, 4, 5]).map(isoDate)).toEqual([
      "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16",
    ]);
    expect(viewDays("day", local(2026, 10, 15, 13), 1, [1]).map(isoDate)).toEqual(["2026-10-15"]);
  });

  it("computes the visible range and navigation per view", () => {
    const week = visibleRange("week", local(2026, 10, 15), 1, [1, 2, 3, 4, 5]);
    expect([isoDate(week.from), isoDate(week.to)]).toEqual(["2026-10-12", "2026-10-19"]);
    const month = visibleRange("month", local(2026, 10, 15), 1, []);
    expect([isoDate(month.from), isoDate(month.to)]).toEqual(["2026-09-28", "2026-11-02"]);
    expect(isoDate(shiftAnchor("month", local(2026, 1, 31), 1))).toBe("2026-02-28");
    expect(isoDate(shiftAnchor("workweek", local(2026, 10, 15), -1))).toBe("2026-10-08");
    expect(isoDate(shiftAnchor("day", local(2026, 10, 15), 1))).toBe("2026-10-16");
  });

  it("numbers weeks the ISO way for Monday starts", () => {
    expect(weekNumber(local(2026, 10, 15), 1)).toBe(42);
  });

  it("titles month and week views", () => {
    const labels = { week: (n: number, range: string) => `W${n} ${range}`, agendaFrom: (d: string) => `from ${d}` };
    expect(viewTitle("month", local(2026, 10, 15), 1, [], enUS, "en", labels)).toBe("October 2026");
    expect(viewTitle("week", local(2026, 10, 15), 1, [], enUS, "en", labels)).toMatch(/^W42 .*12/);
  });
});

describe("occurrences", () => {
  it("turns all-day dates into local midnights", () => {
    const { start, end } = occurrenceRange(occ("2026-10-15", "2026-10-17", true));
    expect(start.getTime()).toBe(local(2026, 10, 15).getTime());
    expect(end.getTime()).toBe(local(2026, 10, 17).getTime());
    expect(occursOnDay(occ("2026-10-15", "2026-10-17", true), local(2026, 10, 16))).toBe(true);
    expect(occursOnDay(occ("2026-10-15", "2026-10-17", true), local(2026, 10, 17))).toBe(false);
  });

  it("splits an event over midnight into two day segments", () => {
    const o = occ(local(2026, 10, 15, 22).toISOString(), local(2026, 10, 16, 2).toISOString());
    expect(daySegment(o, local(2026, 10, 15))).toEqual({ startMin: 1320, endMin: 1440 });
    expect(daySegment(o, local(2026, 10, 16))).toEqual({ startMin: 0, endMin: 120 });
    expect(daySegment(o, local(2026, 10, 17))).toBeNull();
  });

  it("keeps zero-length events on their day", () => {
    const o = occ(local(2026, 10, 15, 9).toISOString(), local(2026, 10, 15, 9).toISOString());
    expect(daySegment(o, local(2026, 10, 15))).toEqual({ startMin: 540, endMin: 540 });
  });

  it("puts all-day and day-long events into the lane and spans them over the shown days", () => {
    expect(isLaneEvent(occ("2026-10-15", "2026-10-16", true))).toBe(true);
    expect(isLaneEvent(occ(local(2026, 10, 15, 8).toISOString(), local(2026, 10, 16, 9).toISOString()))).toBe(true);
    expect(isLaneEvent(occ(local(2026, 10, 15, 8).toISOString(), local(2026, 10, 15, 9).toISOString()))).toBe(false);
    const days = viewDays("week", local(2026, 10, 15), 1, []);
    expect(spanInDays(occ("2026-10-10", "2026-10-14", true), days)).toEqual({ startIdx: 0, endIdx: 1 });
    expect(spanInDays(occ("2026-10-20", "2026-10-21", true), days)).toBeNull();
    expect(isoDate(parseIsoDate("2026-10-15"))).toBe("2026-10-15");
  });
});
