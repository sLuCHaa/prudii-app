import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { addDays, format, isToday, startOfDay } from "date-fns";
import { Plus } from "lucide-react";
import type { Occurrence } from "../../types/calendar";
import type { Task } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { useCalendars, useCalendarSettings, useOccurrences, useTasksInRange } from "../../hooks/useCalendar";
import { useUpdateTask } from "../../hooks/useTasks";
import { isLaneEvent, isoDate, occurrenceRange } from "../../lib/calendar/dates";
import { defaultDraftTimes, DEFAULT_SETTINGS, formatOccurrenceTime } from "../../lib/calendar/format";
import { weekStartsOn } from "../../lib/localeDefaults";
import { dateLocale } from "../../lib/dateUtils";
import { MiniMonth } from "../ui/MiniMonth";
import { EventChip } from "./EventChip";
import { TaskChip } from "./TaskChip";
import { EventPopover } from "./EventPopover";
import { useEventActions } from "./useEventActions";
import { occurrenceId } from "./gridShared";

const NO_OCCURRENCES: Occurrence[] = [];
const NO_TASKS: Task[] = [];

export function AgendaRail() {
  const { t } = useTranslation();
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const openEventById = useAppStore((s) => s.openEventById);
  const openNewEvent = useAppStore((s) => s.openNewEvent);
  const openTaskById = useAppStore((s) => s.openTaskById);
  const [day, setDay] = useState(() => startOfDay(new Date()));
  const weekStart = useMemo(() => weekStartsOn(), []);
  const to = useMemo(() => addDays(day, 1), [day]);
  const { data: occurrences = NO_OCCURRENCES } = useOccurrences(day, to);
  const { data: tasks = NO_TASKS } = useTasksInRange(day, to, true);
  const { data: calendars = [] } = useCalendars();
  const { data: settings = DEFAULT_SETTINGS } = useCalendarSettings();
  const updateTask = useUpdateTask();
  const actions = useEventActions();
  const [popover, setPopover] = useState<{ occ: Occurrence; rect: DOMRect } | null>(null);
  const lane = occurrences.filter(isLaneEvent);
  const timed = occurrences.filter((o) => !isLaneEvent(o));
  const openPopover = (occ: Occurrence, rect: DOMRect) => setPopover({ occ, rect });

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <div className="flex items-center justify-between px-3 pt-3 pb-2">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-text-tertiary">{t("calendar.rail.title")}</h2>
        <button
          type="button"
          onClick={() => openNewEvent({ times: defaultDraftTimes(day, settings) })}
          aria-label={t("calendar.newEvent")}
          title={t("calendar.newEvent")}
          className="grid h-7 w-7 place-items-center rounded-lg text-text-secondary hover:bg-hover"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>
      <div className="px-2">
        <MiniMonth selected={day} weekStart={weekStart} onSelect={(d) => setDay(startOfDay(d))} />
      </div>
      <div className="mt-3 px-3 text-sm font-semibold text-text">
        {isToday(day) ? t("calendar.today") : format(day, "EEEE, PPP", { locale: dateLocale() })}
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto px-2 py-2">
        {occurrences.length === 0 && tasks.length === 0 && <p className="px-1 py-6 text-center text-xs text-text-tertiary">{t("calendar.rail.empty")}</p>}
        {lane.map((o) => (
          <EventChip key={occurrenceId(o)} occurrence={o} variant="bar" use24h={use24h} onOpen={openPopover} />
        ))}
        {timed.map((o) => (
          <button
            key={occurrenceId(o)}
            type="button"
            onClick={(e) => openPopover(o, e.currentTarget.getBoundingClientRect())}
            className="flex w-full gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-hover"
          >
            <span className="w-1 self-stretch rounded-full" style={{ background: o.color }} />
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-xs font-medium ${o.status === "cancelled" ? "line-through text-text-tertiary" : "text-text"}`}>
                {o.title || t("calendar.untitled")}
              </span>
              <span className="block text-[11px] tabular-nums text-text-tertiary">{formatOccurrenceTime(o, use24h, t("calendar.allDay"))}</span>
            </span>
          </button>
        ))}
        {tasks.length > 0 && (
          <>
            <div className="px-1 pt-2 text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{t("calendar.rail.dueTasks")}</div>
            {tasks.map((task) => (
              <TaskChip
                key={task.id}
                task={task}
                use24h={use24h}
                onOpen={(tk) => openTaskById(tk.id)}
                onToggle={(tk) => updateTask.mutate({ id: tk.id, patch: { status: "done" } })}
              />
            ))}
          </>
        )}
      </div>
      {popover && (
        <EventPopover
          occurrence={popover.occ}
          anchor={popover.rect}
          calendarName={calendars.find((c) => c.id === popover.occ.calendar_id)?.name}
          onClose={() => setPopover(null)}
          onEdit={(o) => {
            setPopover(null);
            openEventById(o.event_id, o.occurrence_key, isoDate(occurrenceRange(o).start));
          }}
          onDelete={(o) => {
            setPopover(null);
            void actions.deleteOccurrence(o);
          }}
        />
      )}
      {actions.dialogs}
    </div>
  );
}
