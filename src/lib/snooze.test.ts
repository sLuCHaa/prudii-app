import { describe, it, expect } from "vitest";
import { SNOOZE_PRESETS, toSnoozeStamp } from "./snooze";

const preset = (id: string) => {
  const found = SNOOZE_PRESETS.find((p) => p.id === id);
  if (!found) throw new Error(`no preset "${id}"`);
  return found;
};

// Deliberately timezone-agnostic: these assert the invariants, not literal
// strings, so the suite means the same thing on a CI box running UTC and on a
// laptop in Berlin.
describe("toSnoozeStamp", () => {
  it("emits the SQLite datetime shape", () => {
    expect(toSnoozeStamp(new Date())).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it("emits UTC, because the backend compares against datetime('now')", () => {
    // The regression guard: formatting from local getters instead would shift
    // every snooze by the user's UTC offset.
    const d = new Date(Date.UTC(2026, 4, 17, 14, 30, 15));
    expect(toSnoozeStamp(d)).toBe("2026-05-17 14:30:15");
  });

  it("drops sub-second precision rather than rounding into the next second", () => {
    expect(toSnoozeStamp(new Date(Date.UTC(2026, 0, 1, 0, 0, 0, 999)))).toBe("2026-01-01 00:00:00");
  });
});

describe("SNOOZE_PRESETS", () => {
  it("offers the same four options everywhere they are shown", () => {
    expect(SNOOZE_PRESETS.map((p) => p.id)).toEqual([
      "in1Hour",
      "in3Hours",
      "tomorrowMorning",
      "nextMonday",
    ]);
  });

  it("counts the hour presets forward from now", () => {
    const now = new Date(2026, 4, 17, 14, 30, 0);
    expect(preset("in1Hour").at(now).getTime() - now.getTime()).toBe(60 * 60 * 1000);
    expect(preset("in3Hours").at(now).getTime() - now.getTime()).toBe(3 * 60 * 60 * 1000);
  });

  it("puts 'tomorrow morning' at 9am local on the next day", () => {
    const now = new Date(2026, 4, 17, 22, 45, 0);
    const at = preset("tomorrowMorning").at(now);
    expect(at.getHours()).toBe(9);
    expect(at.getMinutes()).toBe(0);
    expect(at.getDate()).toBe(18);
  });

  it("rolls 'tomorrow morning' over a month boundary", () => {
    const at = preset("tomorrowMorning").at(new Date(2026, 4, 31, 12, 0, 0));
    expect(at.getMonth()).toBe(5);
    expect(at.getDate()).toBe(1);
  });

  it("always lands 'next Monday' on a future Monday at 9am", () => {
    // Every weekday, including Monday itself — which must skip a full week
    // rather than resolve to today.
    for (let day = 17; day <= 23; day++) {
      const now = new Date(2026, 4, day, 12, 0, 0);
      const at = preset("nextMonday").at(now);
      expect(at.getDay(), `weekday for ${now.toDateString()}`).toBe(1);
      expect(at.getHours()).toBe(9);
      expect(at.getTime(), `future for ${now.toDateString()}`).toBeGreaterThan(now.getTime());
    }
  });

  it("does not mutate the date it is given", () => {
    const now = new Date(2026, 4, 17, 12, 0, 0);
    const before = now.getTime();
    for (const p of SNOOZE_PRESETS) p.at(now);
    expect(now.getTime()).toBe(before);
  });
});
