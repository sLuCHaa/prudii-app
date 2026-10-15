import { addDays, format } from "date-fns";
import type { Locale } from "date-fns";
import { parseIsoDate } from "./dates";

export const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"] as const;
const WEEKDAY_CODES = ["MO", "TU", "WE", "TH", "FR"];
// A known Sunday; day names are formatted from it so they follow the UI locale.
const REFERENCE_SUNDAY = new Date(2026, 0, 4);

export type RecurrencePreset = "none" | "daily" | "weekdays" | "weekly" | "monthlyDay" | "monthlyNth" | "yearly" | "custom";
export const PRESETS = ["daily", "weekdays", "weekly", "monthlyDay", "monthlyNth", "yearly"] as const;
export type Freq = "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
export type RecurrenceEnd = { kind: "never" } | { kind: "until"; date: string } | { kind: "count"; count: number };

export interface RecurrenceSpec {
  freq: Freq;
  interval: number;
  byDay: string[];
  byMonthDay: number[];
  end: RecurrenceEnd;
}

// i18next's overloaded t only fits a loose signature.
type Translate = (key: string, opts?: any) => string;

export function nthWeekday(d: Date): { n: number; code: string } {
  const n = Math.ceil(d.getDate() / 7);
  return { n: n >= 5 ? -1 : n, code: DAY_CODES[d.getDay()] };
}

export function presetRrule(preset: RecurrencePreset, start: Date): string | null {
  switch (preset) {
    case "none":
    case "custom":
      return null;
    case "daily":
      return "FREQ=DAILY";
    case "weekdays":
      return `FREQ=WEEKLY;BYDAY=${WEEKDAY_CODES.join(",")}`;
    case "weekly":
      return `FREQ=WEEKLY;BYDAY=${DAY_CODES[start.getDay()]}`;
    case "monthlyDay":
      return `FREQ=MONTHLY;BYMONTHDAY=${start.getDate()}`;
    case "monthlyNth": {
      const { n, code } = nthWeekday(start);
      return `FREQ=MONTHLY;BYDAY=${n}${code}`;
    }
    case "yearly":
      return "FREQ=YEARLY";
  }
}

export function parseRrule(rule: string): RecurrenceSpec {
  const parts = new Map<string, string>(
    rule
      .replace(/^RRULE:/i, "")
      .split(";")
      .map((p) => {
        const [k, v = ""] = p.split("=");
        return [k.trim().toUpperCase(), v.trim()] as [string, string];
      }),
  );
  const freqs: Freq[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
  const freq = freqs.find((f) => f === parts.get("FREQ")?.toUpperCase()) ?? "WEEKLY";
  const interval = Math.max(1, Number(parts.get("INTERVAL") ?? 1) || 1);
  const byDay = (parts.get("BYDAY") ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  const byMonthDay = (parts.get("BYMONTHDAY") ?? "").split(",").filter(Boolean).map(Number).filter((n) => Number.isInteger(n) && n !== 0);
  const until = parts.get("UNTIL");
  const count = Number(parts.get("COUNT"));
  let end: RecurrenceEnd = { kind: "never" };
  if (until && /^\d{8}/.test(until)) end = { kind: "until", date: `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}` };
  else if (Number.isInteger(count) && count > 0) end = { kind: "count", count };
  return { freq, interval, byDay, byMonthDay, end };
}

export function buildRrule(spec: RecurrenceSpec): string {
  const parts = [`FREQ=${spec.freq}`];
  if (spec.interval > 1) parts.push(`INTERVAL=${spec.interval}`);
  if (spec.byDay.length) parts.push(`BYDAY=${spec.byDay.join(",")}`);
  if (spec.byMonthDay.length) parts.push(`BYMONTHDAY=${spec.byMonthDay.join(",")}`);
  if (spec.end.kind === "until") parts.push(`UNTIL=${spec.end.date.replace(/-/g, "")}`);
  if (spec.end.kind === "count") parts.push(`COUNT=${spec.end.count}`);
  return parts.join(";");
}

export function detectPreset(rule: string | null, start: Date): RecurrencePreset {
  if (!rule) return "none";
  const normalized = buildRrule(parseRrule(rule));
  return PRESETS.find((p) => presetRrule(p, start) === normalized) ?? "custom";
}

function dayName(code: string, locale: Locale): string {
  const idx = DAY_CODES.indexOf(code.slice(-2) as (typeof DAY_CODES)[number]);
  return idx < 0 ? code : format(addDays(REFERENCE_SUNDAY, idx), "EEEE", { locale });
}

export function describeRrule(rule: string | null, start: Date, t: Translate, locale: Locale, lang: string): string {
  if (!rule) return t("calendar.rrule.none");
  const spec = parseRrule(rule);
  const count = spec.interval;
  let text: string;
  const isWeekdays = spec.byDay.length === 5 && WEEKDAY_CODES.every((c) => spec.byDay.includes(c));
  if (spec.freq === "WEEKLY" && isWeekdays && count === 1) {
    text = t("calendar.rrule.weekdays");
  } else if (spec.freq === "DAILY") {
    text = t("calendar.rrule.daily", { count });
  } else if (spec.freq === "WEEKLY") {
    const codes = spec.byDay.length ? spec.byDay : [DAY_CODES[start.getDay()]];
    text = t("calendar.rrule.weekly", { count, days: codes.map((c) => dayName(c, locale)).join(", ") });
  } else if (spec.freq === "MONTHLY") {
    const nth = spec.byDay.find((d) => /^-?\d/.test(d));
    if (nth) {
      const n = parseInt(nth, 10);
      text = t("calendar.rrule.monthlyNth", { count, nth: t(`calendar.rrule.nth.${n < 0 ? "last" : n}`), weekday: dayName(nth, locale) });
    } else {
      text = t("calendar.rrule.monthlyDay", { count, day: spec.byMonthDay[0] ?? start.getDate() });
    }
  } else {
    text = t("calendar.rrule.yearly", { count, date: new Intl.DateTimeFormat(lang, { day: "numeric", month: "long" }).format(start) });
  }
  if (spec.end.kind === "until") text += t("calendar.rrule.untilSuffix", { date: format(parseIsoDate(spec.end.date), "P", { locale }) });
  if (spec.end.kind === "count") text += t("calendar.rrule.countSuffix", { count: spec.end.count });
  return text;
}
