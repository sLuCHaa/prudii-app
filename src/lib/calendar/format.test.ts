import { describe, it, expect } from "vitest";
import { defaultDraftTimes, DEFAULT_SETTINGS, formatOccurrenceTime } from "./format";
import type { Occurrence } from "../../types/calendar";

const base: Occurrence = {
  event_id: "e", calendar_id: "c", color: "#000", title: "T", location: "", description: "", all_day: false,
  start: "", end: "", occurrence_key: "", is_recurring: false, is_override: false, status: "confirmed",
  my_partstat: null, is_organizer: false, has_attendees: false, read_only: false,
};

describe("formatOccurrenceTime", () => {
  it("formats all-day, same-day and multi-day occurrences", () => {
    expect(formatOccurrenceTime({ ...base, all_day: true, start: "2026-10-15", end: "2026-10-16" }, true, "All day")).toBe("All day");
    const same = { ...base, start: new Date(2026, 9, 15, 9).toISOString(), end: new Date(2026, 9, 15, 9, 30).toISOString() };
    expect(formatOccurrenceTime(same, true, "All day")).toBe("09:00 – 09:30");
    const multi = { ...base, start: new Date(2026, 9, 15, 22).toISOString(), end: new Date(2026, 9, 16, 2).toISOString() };
    expect(formatOccurrenceTime(multi, true, "All day")).toMatch(/22:00 – .*02:00/);
  });
});

describe("defaultDraftTimes", () => {
  it("starts at the next full hour on today and at 09:00 on other days", () => {
    const today = defaultDraftTimes(new Date(), DEFAULT_SETTINGS);
    expect(new Date(today.start).getMinutes()).toBe(0);
    expect(new Date(today.end).getTime() - new Date(today.start).getTime()).toBe(60 * 60_000);
    const other = defaultDraftTimes(new Date(2030, 0, 2), DEFAULT_SETTINGS);
    expect(new Date(other.start).getHours()).toBe(9);
    expect(defaultDraftTimes(new Date(2030, 0, 2), DEFAULT_SETTINGS, true)).toEqual({ all_day: true, start: "2030-01-02", end: "2030-01-03" });
  });
});
