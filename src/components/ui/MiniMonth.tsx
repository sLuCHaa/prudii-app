import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { addMonths, format, isBefore, isSameDay, isSameMonth, isToday, startOfDay, startOfMonth } from "date-fns";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { WeekDay } from "../../lib/localeDefaults";
import { gridKeyTarget, isoDate, monthGrid } from "../../lib/calendar/dates";
import { dateLocale } from "../../lib/dateUtils";

const SIZES = {
  sm: { title: "text-xs", nav: "h-6 w-6", weekday: "text-[10px]", weekdayFormat: "EEEEE", day: "h-6 w-6 text-[11px]" },
  md: { title: "text-sm", nav: "h-7 w-7", weekday: "text-[11px]", weekdayFormat: "EEEEEE", day: "h-8 w-8 text-xs" },
};

interface MiniMonthProps {
  selected: Date | null;
  weekStart: WeekDay;
  onSelect: (day: Date) => void;
  min?: Date;
  size?: keyof typeof SIZES;
  autoFocus?: boolean;
}

export function MiniMonth({ selected, weekStart, onSelect, min, size = "sm", autoFocus = false }: MiniMonthProps) {
  const { t } = useTranslation();
  const s = SIZES[size];
  const [cursor, setCursor] = useState(() => startOfDay(selected ?? new Date()));
  const [month, setMonth] = useState(() => startOfMonth(cursor));
  const gridRef = useRef<HTMLDivElement>(null);
  const pullFocus = useRef(autoFocus);
  const selectedTime = selected?.getTime();
  const floor = min ? startOfDay(min) : null;

  useEffect(() => {
    if (selectedTime === undefined) return;
    const day = new Date(selectedTime);
    setCursor(startOfDay(day));
    setMonth((m) => (isSameMonth(m, day) ? m : startOfMonth(day)));
  }, [selectedTime]);

  const weeks = useMemo(() => monthGrid(month, weekStart), [month, weekStart]);
  const days = weeks.flat();
  // One tab stop: the cursor day, or the month's first selectable day once paging moved it out of view.
  const tabDay = days.some((d) => isSameDay(d, cursor))
    ? cursor
    : (days.find((d) => isSameMonth(d, month) && !(floor && isBefore(d, floor))) ?? cursor);

  useEffect(() => {
    if (!pullFocus.current) return;
    pullFocus.current = false;
    gridRef.current?.querySelector<HTMLElement>('[tabindex="0"]')?.focus();
  }, [cursor]);

  function onKeyDown(e: KeyboardEvent) {
    const next = gridKeyTarget(tabDay, e.key, weekStart);
    if (!next) return;
    e.preventDefault();
    // The mail list and calendar view bind arrows on window.
    e.stopPropagation();
    const target = floor && isBefore(next, floor) ? floor : next;
    pullFocus.current = true;
    setCursor(target);
    if (!isSameMonth(target, month)) setMonth(startOfMonth(target));
  }

  return (
    <div className="select-none">
      <div className="flex items-center justify-between px-1 pb-1">
        <span className={`${s.title} font-semibold text-text`}>{format(month, "LLLL yyyy", { locale: dateLocale() })}</span>
        <div className="flex">
          <button type="button" aria-label={t("calendar.previous")} onClick={() => setMonth((m) => addMonths(m, -1))} className={`grid ${s.nav} place-items-center rounded-md text-text-tertiary hover:bg-hover`}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </button>
          <button type="button" aria-label={t("calendar.next")} onClick={() => setMonth((m) => addMonths(m, 1))} className={`grid ${s.nav} place-items-center rounded-md text-text-tertiary hover:bg-hover`}>
            <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      <div ref={gridRef} onKeyDown={onKeyDown} className="grid grid-cols-7 text-center">
        {weeks[0].map((d) => (
          <span key={d.getDay()} className={`py-0.5 ${s.weekday} text-text-tertiary`}>
            {format(d, s.weekdayFormat, { locale: dateLocale() })}
          </span>
        ))}
        {days.map((d) => {
          const selectedDay = selected ? isSameDay(d, selected) : false;
          const outside = !isSameMonth(d, month);
          const disabled = floor ? isBefore(d, floor) : false;
          return (
            <button
              key={isoDate(d)}
              type="button"
              tabIndex={isSameDay(d, tabDay) ? 0 : -1}
              disabled={disabled}
              aria-label={format(d, "PPPP", { locale: dateLocale() })}
              aria-pressed={selectedDay}
              aria-current={isToday(d) ? "date" : undefined}
              onClick={() => {
                setCursor(startOfDay(d));
                onSelect(d);
              }}
              className={`mx-auto grid ${s.day} place-items-center rounded-full tabular-nums transition-colors outline-none focus-visible:ring-2 focus-visible:ring-accent disabled:pointer-events-none disabled:opacity-35 ${
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
