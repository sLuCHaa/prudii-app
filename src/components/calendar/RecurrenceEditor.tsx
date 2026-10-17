import { useState } from "react";
import { useTranslation } from "react-i18next";
import { addDays, format } from "date-fns";
import { DateField } from "../ui/DateField";
import { Select } from "../ui/Select";
import {
  buildRrule, DAY_CODES, describeRrule, detectPreset, nthWeekday, parseRrule, presetRrule, PRESETS,
  type Freq, type RecurrencePreset, type RecurrenceSpec,
} from "../../lib/calendar/rrule";
import { isoDate } from "../../lib/calendar/dates";
import { dateLocale } from "../../lib/dateUtils";
import { weekStartsOn } from "../../lib/localeDefaults";

const FREQS: Freq[] = ["DAILY", "WEEKLY", "MONTHLY", "YEARLY"];
const REFERENCE_SUNDAY = new Date(2026, 0, 4);
const INPUT = "h-9 px-3 rounded-control inset-shadow-field border border-border bg-bg-secondary text-sm text-text outline-none focus:border-accent";

interface RecurrenceEditorProps {
  value: string | null;
  start: Date;
  onChange: (rule: string | null) => void;
}

export function RecurrenceEditor({ value, start, onChange }: RecurrenceEditorProps) {
  const { t, i18n } = useTranslation();
  const detected = detectPreset(value, start);
  const [custom, setCustom] = useState(detected === "custom");
  const options = [
    { value: "none", label: t("calendar.rrule.none") },
    ...PRESETS.map((p) => ({ value: p, label: describeRrule(presetRrule(p, start), start, t, dateLocale(), i18n.language) })),
    { value: "custom", label: t("calendar.repeat.custom") },
  ];

  function pick(v: string) {
    if (v === "custom") {
      setCustom(true);
      if (!value) onChange(presetRrule("weekly", start));
      return;
    }
    setCustom(false);
    onChange(v === "none" ? null : presetRrule(v as RecurrencePreset, start));
  }

  return (
    <div className="grid gap-2">
      <Select value={custom ? "custom" : detected} options={options} onChange={pick} ariaLabel={t("calendar.drawer.repeat")} />
      {custom && value && (
        <>
          <CustomRule spec={parseRrule(value)} start={start} onChange={(spec) => onChange(buildRrule(spec))} />
          <p className="text-xs text-text-tertiary">{describeRrule(value, start, t, dateLocale(), i18n.language)}</p>
        </>
      )}
    </div>
  );
}

function CustomRule({ spec, start, onChange }: { spec: RecurrenceSpec; start: Date; onChange: (spec: RecurrenceSpec) => void }) {
  const { t } = useTranslation();
  const weekStart = weekStartsOn();
  const dayOrder = Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
  const startCode = DAY_CODES[start.getDay()];
  const nth = nthWeekday(start);
  const set = (patch: Partial<RecurrenceSpec>) => onChange({ ...spec, ...patch });
  const monthlyNth = spec.freq === "MONTHLY" && spec.byDay.some((d) => /^-?\d/.test(d));

  function setFreq(freq: Freq) {
    set({ freq, byDay: freq === "WEEKLY" ? [startCode] : [], byMonthDay: freq === "MONTHLY" ? [start.getDate()] : [] });
  }

  function toggleDay(code: string) {
    const next = spec.byDay.includes(code) ? spec.byDay.filter((c) => c !== code) : [...spec.byDay, code];
    set({ byDay: next.length ? DAY_CODES.filter((c) => next.includes(c)) : [startCode] });
  }

  return (
    <div className="grid gap-3 rounded-lg border border-border p-3">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-text-secondary">{t("calendar.repeat.every")}</span>
        <input
          type="number"
          min={1}
          max={99}
          value={spec.interval}
          onChange={(e) => set({ interval: Math.min(99, Math.max(1, Number(e.target.value) || 1)) })}
          className={`${INPUT} w-16`}
        />
        <div className="flex-1">
          <Select
            value={spec.freq}
            options={FREQS.map((f) => ({ value: f, label: t(`calendar.repeat.unit.${f}`, { count: spec.interval }) }))}
            onChange={(v) => setFreq(v as Freq)}
          />
        </div>
      </div>

      {spec.freq === "WEEKLY" && (
        <div className="flex gap-1">
          {dayOrder.map((i) => {
            const code = DAY_CODES[i];
            const on = spec.byDay.includes(code);
            return (
              <button
                key={code}
                type="button"
                aria-pressed={on}
                onClick={() => toggleDay(code)}
                className={`h-8 w-8 rounded-full text-xs font-medium transition-colors ${on ? "bg-accent text-white" : "bg-bg-secondary text-text-secondary hover:bg-hover"}`}
              >
                {format(addDays(REFERENCE_SUNDAY, i), "EEEEEE", { locale: dateLocale() })}
              </button>
            );
          })}
        </div>
      )}

      {spec.freq === "MONTHLY" && (
        <div className="grid gap-1.5 text-sm text-text">
          <label className="flex items-center gap-2">
            <input type="radio" checked={!monthlyNth} onChange={() => set({ byDay: [], byMonthDay: [start.getDate()] })} />
            {t("calendar.repeat.monthOnDay", { day: start.getDate() })}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={monthlyNth} onChange={() => set({ byMonthDay: [], byDay: [`${nth.n}${nth.code}`] })} />
            {t("calendar.repeat.monthOnNth", {
              nth: t(`calendar.rrule.nth.${nth.n < 0 ? "last" : nth.n}`),
              weekday: format(start, "EEEE", { locale: dateLocale() }),
            })}
          </label>
        </div>
      )}

      <div className="grid gap-1.5 text-sm text-text">
        <span className="text-xs font-medium text-text-secondary">{t("calendar.repeat.ends")}</span>
        <label className="flex items-center gap-2">
          <input type="radio" checked={spec.end.kind === "never"} onChange={() => set({ end: { kind: "never" } })} />
          {t("calendar.repeat.never")}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={spec.end.kind === "until"} onChange={() => set({ end: { kind: "until", date: isoDate(addDays(start, 30)) } })} />
          {t("calendar.repeat.onDate")}
          {spec.end.kind === "until" && (
            <DateField
              value={spec.end.date}
              min={isoDate(start)}
              onChange={(date) => set({ end: { kind: "until", date } })}
              ariaLabel={t("calendar.repeat.onDate")}
              className="w-48"
            />
          )}
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={spec.end.kind === "count"} onChange={() => set({ end: { kind: "count", count: 10 } })} />
          {t("calendar.repeat.after")}
          {spec.end.kind === "count" && (
            <>
              <input
                type="number"
                min={1}
                max={999}
                value={spec.end.count}
                onChange={(e) => set({ end: { kind: "count", count: Math.min(999, Math.max(1, Number(e.target.value) || 1)) } })}
                className={`${INPUT} w-20`}
              />
              <span>{t("calendar.repeat.occurrences", { count: spec.end.count })}</span>
            </>
          )}
        </label>
      </div>
    </div>
  );
}
