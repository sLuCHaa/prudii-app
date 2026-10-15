import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { addMonths, format, isSameDay, isSameMonth, isToday, startOfMonth } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { WeekDay } from "../../lib/localeDefaults";
import { isoDate, monthGrid } from "../../lib/calendar/dates";
import { dateLocale } from "../../lib/dateUtils";

interface MiniMonthProps {
  selected: Date;
  weekStart: WeekDay;
  onSelect: (day: Date) => void;
}

export function MiniMonth({ selected, weekStart, onSelect }: MiniMonthProps) {
  const { t } = useTranslation();
  const [month, setMonth] = useState(() => startOfMonth(selected));
  useEffect(() => {
    setMonth((m) => (isSameMonth(m, selected) ? m : startOfMonth(selected)));
  }, [selected]);
  const weeks = useMemo(() => monthGrid(month, weekStart), [month, weekStart]);

  return (
    <div className="select-none">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-xs font-semibold text-text">{format(month, "LLLL yyyy", { locale: dateLocale() })}</span>
        <div className="flex">
          <button type="button" aria-label={t("calendar.previous")} onClick={() => setMonth((m) => addMonths(m, -1))} className="grid h-6 w-6 place-items-center rounded-md text-text-tertiary hover:bg-hover">
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label={t("calendar.next")} onClick={() => setMonth((m) => addMonths(m, 1))} className="grid h-6 w-6 place-items-center rounded-md text-text-tertiary hover:bg-hover">
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div className="grid grid-cols-7 text-center">
        {weeks[0].map((d) => (
          <span key={d.getDay()} className="py-0.5 text-[10px] text-text-tertiary">
            {format(d, "EEEEE", { locale: dateLocale() })}
          </span>
        ))}
        {weeks.flat().map((d) => {
          const selectedDay = isSameDay(d, selected);
          const outside = !isSameMonth(d, month);
          return (
            <button
              key={isoDate(d)}
              type="button"
              onClick={() => onSelect(d)}
              className={`mx-auto grid h-6 w-6 place-items-center rounded-full text-[11px] tabular-nums transition-colors ${
                selectedDay
                  ? "bg-accent text-white font-semibold"
                  : isToday(d)
                    ? "text-accent font-semibold ring-1 ring-accent/40"
                    : outside
                      ? "text-text-tertiary hover:bg-hover"
                      : "text-text-secondary hover:bg-hover"
              }`}
            >
              {d.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  );
}
