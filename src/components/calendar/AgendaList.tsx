import { useEffect, useMemo, useRef } from "react";
import { useTranslation } from "react-i18next";
import { format, isToday, startOfDay } from "date-fns";
import { CalendarDays, Repeat } from "lucide-react";
import type { Occurrence } from "../../types/calendar";
import type { Task } from "../../types";
import { isoDate, occurrenceRange } from "../../lib/calendar/dates";
import { formatOccurrenceTime } from "../../lib/calendar/format";
import { dateLocale } from "../../lib/dateUtils";
import { useAppStore } from "../../stores/appStore";
import { EmptyState } from "../ui/EmptyState";
import { TaskChip } from "./TaskChip";
import { occurrenceId, type CalendarGridHandlers } from "./gridShared";

interface AgendaListProps extends Pick<CalendarGridHandlers, "onOpen" | "onOpenTask" | "onToggleTask"> {
  occurrences: Occurrence[];
  tasks: Task[];
  onReachEnd?: () => void;
  emptyTitle: string;
  emptyDescription?: string;
}

interface DayGroup {
  day: Date;
  events: Occurrence[];
  tasks: Task[];
}

export function AgendaList({ occurrences, tasks, onOpen, onOpenTask, onToggleTask, onReachEnd, emptyTitle, emptyDescription }: AgendaListProps) {
  const { t } = useTranslation();
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const scroller = useRef<HTMLDivElement>(null);
  const sentinel = useRef<HTMLDivElement>(null);

  const groups = useMemo(() => {
    const map = new Map<string, DayGroup>();
    const entry = (day: Date) => {
      const key = isoDate(day);
      let group = map.get(key);
      if (!group) {
        group = { day: startOfDay(day), events: [], tasks: [] };
        map.set(key, group);
      }
      return group;
    };
    for (const o of occurrences) entry(occurrenceRange(o).start).events.push(o);
    for (const task of tasks) if (task.due_at) entry(new Date(task.due_at)).tasks.push(task);
    return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, g]) => g);
  }, [occurrences, tasks]);

  useEffect(() => {
    const el = sentinel.current;
    if (!onReachEnd || !el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) onReachEnd();
    }, { root: scroller.current, rootMargin: "200px" });
    io.observe(el);
    return () => io.disconnect();
  }, [onReachEnd, occurrences, tasks]);

  return (
    <div ref={scroller} className="h-full overflow-y-auto">
      {groups.length === 0 && (
        <EmptyState icon={<CalendarDays className="w-10 h-10 text-text-tertiary" />} title={emptyTitle} description={emptyDescription} />
      )}
      {groups.map((g) => (
        <section key={isoDate(g.day)}>
          <h3 className="sticky top-0 z-10 flex items-center gap-2 border-b border-border bg-surface/95 px-6 py-2 text-xs font-semibold text-text-secondary backdrop-blur">
            {format(g.day, "EEEE, PPP", { locale: dateLocale() })}
            {isToday(g.day) && <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[10px] text-accent">{t("calendar.today")}</span>}
          </h3>
          <ul>
            {g.events.map((o) => (
              <li key={occurrenceId(o)}>
                <button
                  type="button"
                  onClick={(e) => onOpen(o, e.currentTarget.getBoundingClientRect())}
                  className="w-full flex items-start gap-3 px-6 py-2 text-left hover:bg-hover transition-colors"
                >
                  <span className="w-36 shrink-0 text-xs text-text-secondary tabular-nums">{formatOccurrenceTime(o, use24h, t("calendar.allDay"))}</span>
                  <span className="mt-1 w-2 h-2 shrink-0 rounded-full" style={{ background: o.color }} />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-sm ${o.status === "cancelled" ? "line-through text-text-tertiary" : "text-text"}`}>
                      {o.title || t("calendar.untitled")}
                    </span>
                    {o.location && <span className="block truncate text-xs text-text-tertiary">{o.location}</span>}
                  </span>
                  {o.is_recurring && <Repeat className="mt-0.5 w-3.5 h-3.5 shrink-0 text-text-tertiary" />}
                </button>
              </li>
            ))}
            {g.tasks.map((task) => (
              <li key={task.id} className="px-6 py-1">
                <TaskChip task={task} use24h={use24h} onOpen={onOpenTask} onToggle={onToggleTask} />
              </li>
            ))}
          </ul>
        </section>
      ))}
      <div ref={sentinel} className="h-8" />
    </div>
  );
}
