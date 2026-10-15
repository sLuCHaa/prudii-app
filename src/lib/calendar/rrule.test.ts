import { describe, it, expect } from "vitest";
import { enUS } from "date-fns/locale";
import { buildRrule, describeRrule, detectPreset, nthWeekday, parseRrule, presetRrule } from "./rrule";

const thu = new Date(2026, 9, 15, 9); // Thursday, 3rd Thursday of October 2026
const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key);

describe("presets", () => {
  it("builds rules from the start date", () => {
    expect(presetRrule("weekly", thu)).toBe("FREQ=WEEKLY;BYDAY=TH");
    expect(presetRrule("monthlyDay", thu)).toBe("FREQ=MONTHLY;BYMONTHDAY=15");
    expect(presetRrule("monthlyNth", thu)).toBe("FREQ=MONTHLY;BYDAY=3TH");
    expect(presetRrule("weekdays", thu)).toBe("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR");
    expect(presetRrule("none", thu)).toBeNull();
  });

  it("uses 'last' for a fifth weekday", () => {
    expect(nthWeekday(new Date(2026, 9, 29))).toEqual({ n: -1, code: "TH" });
  });

  it("recognises presets and falls back to custom", () => {
    expect(detectPreset(null, thu)).toBe("none");
    expect(detectPreset("FREQ=WEEKLY;BYDAY=TH", thu)).toBe("weekly");
    expect(detectPreset("RRULE:FREQ=MONTHLY;BYDAY=3TH", thu)).toBe("monthlyNth");
    expect(detectPreset("FREQ=WEEKLY;INTERVAL=2;BYDAY=TH", thu)).toBe("custom");
  });
});

describe("parse and build", () => {
  it("round-trips interval, days and end conditions", () => {
    const spec = parseRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231T225959Z");
    expect(spec).toEqual({ freq: "WEEKLY", interval: 2, byDay: ["MO", "WE"], byMonthDay: [], end: { kind: "until", date: "2026-12-31" } });
    expect(buildRrule(spec)).toBe("FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;UNTIL=20261231");
    expect(parseRrule("FREQ=DAILY;COUNT=5").end).toEqual({ kind: "count", count: 5 });
    expect(buildRrule({ freq: "MONTHLY", interval: 1, byDay: [], byMonthDay: [31], end: { kind: "never" } })).toBe("FREQ=MONTHLY;BYMONTHDAY=31");
  });
});

describe("describeRrule", () => {
  it("picks the matching sentence with its values", () => {
    expect(describeRrule(null, thu, t, enUS, "en")).toBe("calendar.rrule.none");
    expect(describeRrule("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", thu, t, enUS, "en")).toBe("calendar.rrule.weekdays");
    expect(describeRrule("FREQ=WEEKLY;INTERVAL=2;BYDAY=TH", thu, t, enUS, "en")).toBe('calendar.rrule.weekly|{"count":2,"days":"Thursday"}');
    expect(describeRrule("FREQ=MONTHLY;BYDAY=3TH;COUNT=4", thu, t, enUS, "en")).toBe(
      'calendar.rrule.monthlyNth|{"count":1,"nth":"calendar.rrule.nth.3","weekday":"Thursday"}calendar.rrule.countSuffix|{"count":4}',
    );
  });
});
