import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Select } from "../ui/Select";
import { Button } from "../ui/Button";

export const PRESET_MINUTES = [0, 5, 10, 15, 30, 60, 1440];
const MAX_MINUTES = 7 * 24 * 60;
const INPUT = "h-9 px-3 rounded-lg border border-border bg-bg-secondary text-sm text-text outline-none focus:border-accent";

// i18next's overloaded t only fits a loose signature.
type Translate = (key: string, opts?: any) => string;

export function alarmLabel(minutes: number, t: Translate): string {
  if (minutes === 0) return t("calendar.alarm.atStart");
  if (minutes % 1440 === 0) return t("calendar.alarm.days", { count: minutes / 1440 });
  if (minutes % 60 === 0) return t("calendar.alarm.hours", { count: minutes / 60 });
  return t("calendar.alarm.minutes", { count: minutes });
}

interface AlarmEditorProps {
  value: number[];
  allDay: boolean;
  onChange: (alarms: number[]) => void;
}

export function AlarmEditor({ value, allDay, onChange }: AlarmEditorProps) {
  const { t } = useTranslation();
  const [custom, setCustom] = useState(false);
  const [amount, setAmount] = useState(1);
  const [unit, setUnit] = useState<"m" | "h" | "d">("h");

  const add = (minutes: number) => {
    if (!value.includes(minutes)) onChange([...value, minutes].sort((a, b) => a - b));
  };
  const options = [
    ...PRESET_MINUTES.filter((m) => !value.includes(m)).map((m) => ({ value: String(m), label: alarmLabel(m, t) })),
    { value: "custom", label: t("calendar.alarm.custom") },
  ];

  return (
    <div className="grid gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((m) => (
            <span key={m} className="inline-flex h-7 items-center gap-1 rounded-full border border-border bg-bg-secondary pl-2.5 pr-1 text-xs text-text">
              {alarmLabel(m, t)}
              <button
                type="button"
                aria-label={t("common.remove")}
                onClick={() => onChange(value.filter((x) => x !== m))}
                className="grid h-5 w-5 place-items-center rounded-full text-text-tertiary hover:bg-hover hover:text-text"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Select
        value=""
        placeholder={t("calendar.alarm.add")}
        options={options}
        onChange={(v) => (v === "custom" ? setCustom(true) : add(Number(v)))}
        ariaLabel={t("calendar.alarm.add")}
      />
      {custom && (
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            value={amount}
            onChange={(e) => setAmount(Math.max(1, Number(e.target.value) || 1))}
            className={`${INPUT} w-20`}
          />
          <div className="flex-1">
            <Select
              value={unit}
              options={[
                { value: "m", label: t("calendar.alarm.unitMinutes") },
                { value: "h", label: t("calendar.alarm.unitHours") },
                { value: "d", label: t("calendar.alarm.unitDays") },
              ]}
              onChange={(v) => setUnit(v as "m" | "h" | "d")}
            />
          </div>
          <Button
            size="sm"
            type="button"
            onClick={() => {
              add(Math.min(MAX_MINUTES, amount * (unit === "d" ? 1440 : unit === "h" ? 60 : 1)));
              setCustom(false);
            }}
          >
            {t("common.create")}
          </Button>
        </div>
      )}
      {allDay && <p className="text-xs text-text-tertiary">{t("calendar.alarm.allDayHint")}</p>}
    </div>
  );
}
