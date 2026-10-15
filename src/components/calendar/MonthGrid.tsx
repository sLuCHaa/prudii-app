import { useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import type { WeekDay } from "../../lib/localeDefaults";
import type { Occurrence } from "../../types/calendar";
import type { Task } from "../../types";
import { isLaneEvent, isoDate, monthGrid, occursOnDay, spanInDays } from "../../lib/calendar/dates";
import { layoutSpans } from "../../lib/calendar/layout";
import { dateLocale } from "../../lib/dateUtils";
import { useAppStore } from "../../stores/appStore";
import { EventChip } from "./EventChip";
import { TaskChip } from "./TaskChip";
import { DayListPopover } from "./DayListPopover";
import { acceptsCalendarDrag, handleDayDrop, occurrenceId, tasksOnDay, type CalendarGridHandlers } from "./gridShared";

const HEADER_PX = 30;
const LANE_PX = 22;
const MAX_LANES = 3;
const MAX_CELL_ITEMS = 4;

interface MonthGridProps extends CalendarGridHandlers {
  anchor: Date;
  weekStart: WeekDay;
  occurrences: Occurrence[];
  tasks: Task[];
  onQuickCreate: (day: Date, title: string) => void;
}

export function MonthGrid({ anchor, weekStart, occurrences, tasks, onQuickCreate, ...handlers }: MonthGridProps) {
  const weeks = useMemo(() => monthGrid(anchor, weekStart), [anchor, weekStart]);
  const [dayList, setDayList] = useState<{ day: Date; rect: DOMRect } | null>(null);
  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="grid grid-cols-7 shrink-0 border-b border-border">
        {weeks[0].map((d) => (
          <div key={d.getDay()} className="px-2 py-1.5 text-[11px] font-medium uppercase tracking-wide text-text-tertiary">
            {format(d, "EEE", { locale: dateLocale() })}
          </div>
        ))}
      </div>
      <div className="flex-1 min-h-0 grid" style={{ gridTemplateRows: `repeat(${weeks.length}, minmax(0, 1fr))` }}>
        {weeks.map((week) => (
          <WeekRow
            key={isoDate(week[0])}
            week={week}
            month={anchor.getMonth()}
            occurrences={occurrences}
            tasks={tasks}
            onQuickCreate={onQuickCreate}
            onShowDay={(day, rect) => setDayList({ day, rect })}
            {...handlers}
          />
        ))}
      </div>
      {dayList && (
        <DayListPopover
          day={dayList.day}
          anchor={dayList.rect}
          occurrences={occurrences.filter((o) => occursOnDay(o, dayList.day))}
          tasks={tasksOnDay(tasks, dayList.day)}
          onClose={() => setDayList(null)}
          onOpen={handlers.onOpen}
          onOpenTask={handlers.onOpenTask}
          onToggleTask={handlers.onToggleTask}
        />
      )}
    </div>
  );
}

interface WeekRowProps extends CalendarGridHandlers {
  week: Date[];
  month: number;
  occurrences: Occurrence[];
  tasks: Task[];
  onQuickCreate: (day: Date, title: string) => void;
  onShowDay: (day: Date, rect: DOMRect) => void;
}

function WeekRow({ week, month, occurrences, tasks, onQuickCreate, onShowDay, ...handlers }: WeekRowProps) {
  const { t } = useTranslation();
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const [inlineDay, setInlineDay] = useState<string | null>(null);
  const [dropDay, setDropDay] = useState<string | null>(null);
  const todayIso = isoDate(new Date());

  const spans = useMemo(
    () =>
      occurrences.filter(isLaneEvent).flatMap((o) => {
        const span = spanInDays(o, week);
        return span ? [{ o, ...span }] : [];
      }),
    [occurrences, week],
  );
  const lanes = useMemo(() => layoutSpans(spans.map((s) => ({ id: occurrenceId(s.o), startIdx: s.startIdx, endIdx: s.endIdx }))), [spans]);
  const laneOf = (o: Occurrence) => lanes.get(occurrenceId(o)) ?? 0;

  return (
    <div className="relative grid grid-cols-7 min-h-0 border-b border-border">
      {week.map((day, idx) => {
        const iso = isoDate(day);
        const daySpans = spans.filter((s) => s.startIdx <= idx && s.endIdx >= idx);
        const usedLanes = Math.min(MAX_LANES, daySpans.reduce((m, s) => Math.max(m, laneOf(s.o) + 1), 0));
        const hiddenSpans = daySpans.filter((s) => laneOf(s.o) >= MAX_LANES).length;
        const items = [
          ...occurrences.filter((o) => !isLaneEvent(o) && occursOnDay(o, day)).map((o) => ({ kind: "event" as const, o })),
          ...tasksOnDay(tasks, day).map((task) => ({ kind: "task" as const, task })),
        ];
        const shown = items.slice(0, Math.max(0, MAX_CELL_ITEMS - usedLanes));
        const hidden = items.length - shown.length + hiddenSpans;
        const outside = day.getMonth() !== month;
        return (
          <div
            key={iso}
            onDoubleClick={(e) => {
              if (e.target === e.currentTarget) setInlineDay(iso);
            }}
            onDragOver={(e) => {
              if (!acceptsCalendarDrag(e)) return;
              e.preventDefault();
              setDropDay(iso);
            }}
            onDragLeave={(e) => {
              if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropDay(null);
            }}
            onDrop={(e) => {
              setDropDay(null);
              handleDayDrop(e, day, occurrences, tasks, handlers);
            }}
            className={`relative min-w-0 overflow-hidden px-1 border-l border-border first:border-l-0 transition-colors ${
              outside ? "bg-bg-secondary/50" : ""
            } ${dropDay === iso ? "bg-accent/10" : ""}`}
            style={{ paddingTop: HEADER_PX + usedLanes * LANE_PX }}
          >
            <span
              className={`absolute top-1 left-1.5 w-6 h-6 grid place-items-center rounded-full text-xs ${
                iso === todayIso ? "bg-accent text-white font-semibold" : outside ? "text-text-tertiary" : "text-text-secondary"
              }`}
            >
              {day.getDate()}
            </span>
            <div className="space-y-0.5">
              {shown.map((item) =>
                item.kind === "event" ? (
                  <EventChip key={occurrenceId(item.o)} occurrence={item.o} variant="dot" use24h={use24h} onOpen={handlers.onOpen} />
                ) : (
                  <TaskChip key={item.task.id} task={item.task} use24h={use24h} onOpen={handlers.onOpenTask} onToggle={handlers.onToggleTask} />
                ),
              )}
              {inlineDay === iso && (
                <QuickInput
                  placeholder={t("calendar.quickAddPlaceholder")}
                  onSubmit={(title) => {
                    setInlineDay(null);
                    onQuickCreate(day, title);
                  }}
                  onCancel={() => setInlineDay(null)}
                />
              )}
              {hidden > 0 && (
                <button
                  type="button"
                  onClick={(e) => onShowDay(day, e.currentTarget.getBoundingClientRect())}
                  className="w-full px-1.5 text-left text-[11px] font-medium text-text-tertiary hover:text-text"
                >
                  {t("calendar.more", { count: hidden })}
                </button>
              )}
            </div>
          </div>
        );
      })}
      {spans.map((s) => {
        const lane = laneOf(s.o);
        if (lane >= MAX_LANES) return null;
        return (
          <div
            key={occurrenceId(s.o)}
            className="absolute px-0.5"
            style={{ top: HEADER_PX + lane * LANE_PX, left: `${(s.startIdx / 7) * 100}%`, width: `${((s.endIdx - s.startIdx + 1) / 7) * 100}%` }}
          >
            <EventChip occurrence={s.o} variant="bar" use24h={use24h} onOpen={handlers.onOpen} spanDays={week.slice(s.startIdx, s.endIdx + 1)} />
          </div>
        );
      })}
    </div>
  );
}

function QuickInput({ placeholder, onSubmit, onCancel }: { placeholder: string; onSubmit: (title: string) => void; onCancel: () => void }) {
  const [value, setValue] = useState("");
  const done = useRef(false);
  const finish = (submit: boolean) => {
    if (done.current) return;
    done.current = true;
    if (submit && value.trim()) onSubmit(value.trim());
    else onCancel();
  };
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(true);
        if (e.key === "Escape") {
          e.stopPropagation();
          finish(false);
        }
      }}
      onBlur={() => finish(true)}
      className="w-full h-5 px-1.5 rounded-md border border-accent bg-surface text-[11px] text-text outline-none"
    />
  );
}
