import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Search } from "lucide-react";
import type { CalendarViewKind, EventEditorTarget, EventTimes, Occurrence } from "../../types/calendar";
import type { Task } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { useCalendars, useCalendarSettings, useCreateEvent, useOccurrences, useSearchEvents, useTasksInRange } from "../../hooks/useCalendar";
import { useUpdateTask } from "../../hooks/useTasks";
import { AGENDA_DAYS, isoDate, parseIsoDate, shiftAnchor, viewDays, viewTitle, visibleRange } from "../../lib/calendar/dates";
import { defaultDraftTimes, DEFAULT_SETTINGS } from "../../lib/calendar/format";
import { moveDueToDay } from "../../lib/calendar/drag";
import { weekStartsOn } from "../../lib/localeDefaults";
import { dateLocale } from "../../lib/dateUtils";
import { SPRING_SNAPPY, TRANSITION_INSTANT } from "../motion/tokens";
import { TaskDrawer } from "../tasks/TaskDrawer";
import { Switch } from "../ui/Switch";
import { MiniMonth } from "../ui/MiniMonth";
import { CalendarList } from "./CalendarList";
import { MonthGrid } from "./MonthGrid";
import { TimeGrid } from "./TimeGrid";
import { AgendaList } from "./AgendaList";
import { EventPopover } from "./EventPopover";
import { EventDrawer } from "./EventDrawer";
import { useEventActions } from "./useEventActions";
import type { CalendarGridHandlers } from "./gridShared";
import { Button } from "../ui/Button";

const VIEWS: CalendarViewKind[] = ["month", "week", "workweek", "day", "agenda"];
const MAX_AGENDA_DAYS = 3 * 365;
// Stable identities keep AgendaList's IntersectionObserver from re-subscribing.
const NO_OCCURRENCES: Occurrence[] = [];
const NO_TASKS: Task[] = [];

function editorKey(target: EventEditorTarget): string {
  return target.mode === "new" ? "new" : `${target.eventId}|${target.occurrenceKey ?? ""}`;
}

function ViewSegment({ view, onChange }: { view: CalendarViewKind; onChange: (v: CalendarViewKind) => void }) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("calendar.title")} className="inline-flex items-center gap-0.5 rounded-lg border border-border bg-bg-secondary p-0.5">
      {VIEWS.map((v) => (
        <button key={v} type="button" aria-pressed={view === v} onClick={() => onChange(v)} className="relative rounded-md px-2.5 py-1 text-xs font-medium">
          {view === v && <motion.span layoutId="calendar-view-pill" className="absolute inset-0 rounded-md bg-surface shadow-sm" transition={SPRING_SNAPPY} />}
          <span className={`relative z-10 ${view === v ? "text-accent" : "text-text-tertiary hover:text-text-secondary"}`}>{t(`calendar.views.${v}`)}</span>
        </button>
      ))}
    </div>
  );
}

export function CalendarView() {
  const { t, i18n } = useTranslation();
  const reduce = useReducedMotion();
  const view = useAppStore((s) => s.calendarView);
  const setView = useAppStore((s) => s.setCalendarView);
  const anchorIso = useAppStore((s) => s.calendarAnchor);
  const setAnchor = useAppStore((s) => s.setCalendarAnchor);
  const editor = useAppStore((s) => s.eventEditor);
  const setEditor = useAppStore((s) => s.setEventEditor);
  const openTaskId = useAppStore((s) => s.openTaskId);
  const setOpenTaskId = useAppStore((s) => s.setOpenTaskId);
  const showTasks = useAppStore((s) => s.showTasksInCalendar);
  const setShowTasks = useAppStore((s) => s.setShowTasksInCalendar);
  const { data: settings = DEFAULT_SETTINGS } = useCalendarSettings();
  const { data: calendars = [] } = useCalendars();
  const weekStart = useMemo(() => weekStartsOn(), []);
  const anchor = useMemo(() => parseIsoDate(anchorIso), [anchorIso]);
  const [agendaDays, setAgendaDays] = useState(AGENDA_DAYS);
  const range = useMemo(
    () => visibleRange(view, anchor, weekStart, settings.work_days, agendaDays),
    [view, anchor, weekStart, settings.work_days, agendaDays],
  );
  const { data: occurrences = NO_OCCURRENCES } = useOccurrences(range.from, range.to);
  const { data: tasks = NO_TASKS } = useTasksInRange(range.from, range.to, showTasks);
  const visibleTasks = showTasks ? tasks : NO_TASKS;
  const [search, setSearch] = useState("");
  const searching = search.trim().length >= 2;
  const { data: results = NO_OCCURRENCES } = useSearchEvents(search);
  const [popover, setPopover] = useState<{ occ: Occurrence; rect: DOMRect } | null>(null);
  const [direction, setDirection] = useState<1 | -1>(1);
  const actions = useEventActions();
  const createEvent = useCreateEvent();
  const updateTask = useUpdateTask();
  const defaultCalendar = calendars.find((c) => c.is_default && !c.read_only) ?? calendars.find((c) => !c.read_only);

  useEffect(() => setAgendaDays(AGENDA_DAYS), [anchorIso, view]);
  const extendAgenda = useCallback(() => setAgendaDays((d) => Math.min(d + AGENDA_DAYS, MAX_AGENDA_DAYS)), []);

  const navigate = (dir: 1 | -1) => {
    setDirection(dir);
    setAnchor(isoDate(shiftAnchor(view, anchor, dir)));
  };
  const goToday = () => {
    const today = isoDate(new Date());
    setDirection(today >= anchorIso ? 1 : -1);
    setAnchor(today);
  };
  const newEvent = (times?: EventTimes) => setEditor({ mode: "new", draft: { times: times ?? defaultDraftTimes(anchor, settings) } });

  const handlers: CalendarGridHandlers = {
    onOpen: (occ, rect) => setPopover({ occ, rect }),
    onMove: (occ, times) => void actions.moveOccurrence(occ, times),
    onOpenTask: (task) => setOpenTaskId(task.id),
    onToggleTask: (task) => updateTask.mutate({ id: task.id, patch: { status: "done" } }),
    onMoveTask: (task, day) => {
      if (task.due_at) updateTask.mutate({ id: task.id, patch: { due_at: moveDueToDay(task.due_at, day) } });
    },
  };

  // Re-bound every render so the keys act on the current anchor and view.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT" || target.isContentEditable) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const s = useAppStore.getState();
      if (s.eventEditor || s.openTaskId || s.showSettings) return;
      if (e.key === "n") newEvent();
      else if (e.key === "ArrowLeft") navigate(-1);
      else if (e.key === "ArrowRight") navigate(1);
      else if (e.key === ".") goToday();
      else if (/^[1-5]$/.test(e.key)) setView(VIEWS[Number(e.key) - 1]);
      else return;
      e.preventDefault();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const title = viewTitle(view, anchor, weekStart, settings.work_days, dateLocale(), i18n.language, {
    week: (week, rangeLabel) => t("calendar.weekTitle", { week, range: rangeLabel }),
    agendaFrom: (date) => t("calendar.agendaFrom", { date }),
  });

  let body: ReactNode;
  if (searching) {
    body = <AgendaList occurrences={results} tasks={NO_TASKS} emptyTitle={t("calendar.noMatches")} {...handlers} />;
  } else if (view === "month") {
    body = (
      <MonthGrid
        anchor={anchor}
        weekStart={weekStart}
        occurrences={occurrences}
        tasks={visibleTasks}
        onQuickCreate={(day, eventTitle) => {
          if (defaultCalendar) createEvent.mutate({ calendar_id: defaultCalendar.id, title: eventTitle, times: defaultDraftTimes(day, settings, true), alarms: [] });
        }}
        {...handlers}
      />
    );
  } else if (view === "agenda") {
    body = (
      <AgendaList
        occurrences={occurrences}
        tasks={visibleTasks}
        onReachEnd={extendAgenda}
        emptyTitle={t("calendar.noEvents")}
        emptyDescription={t("calendar.noEventsDesc")}
        {...handlers}
      />
    );
  } else {
    body = (
      <TimeGrid
        days={viewDays(view, anchor, weekStart, settings.work_days)}
        occurrences={occurrences}
        tasks={visibleTasks}
        workStart={settings.work_start_hour}
        workEnd={settings.work_end_hour}
        workDays={settings.work_days}
        defaultDuration={settings.default_duration_minutes}
        onCreate={(times) => newEvent(times)}
        {...handlers}
      />
    );
  }

  return (
    <div className="relative flex h-full bg-surface">
      <aside className="flex w-[220px] shrink-0 flex-col gap-4 overflow-y-auto border-r border-border px-3 py-3">
        <MiniMonth selected={anchor} weekStart={weekStart} onSelect={(d) => setAnchor(isoDate(d))} />
        <CalendarList />
        <label className="flex items-center justify-between gap-2 px-1 text-xs text-text-secondary">
          {t("calendar.showTasks")}
          <Switch checked={showTasks} onChange={setShowTasks} />
        </label>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-3 border-b border-border px-4 py-2.5">
          <CalendarDays className="h-4 w-4 shrink-0 text-accent" />
          <button type="button" onClick={goToday} className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-text hover:bg-hover">
            {t("calendar.today")}
          </button>
          <div className="flex items-center">
            <button type="button" onClick={() => navigate(-1)} aria-label={t("calendar.previous")} className="grid h-7 w-7 place-items-center rounded-control text-text-secondary hover:bg-hover">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button type="button" onClick={() => navigate(1)} aria-label={t("calendar.next")} className="grid h-7 w-7 place-items-center rounded-control text-text-secondary hover:bg-hover">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>
          <h1 className="min-w-0 truncate text-base font-semibold text-text">{title}</h1>
          <div className="ml-auto flex items-center gap-2">
            <div className="relative w-52">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-tertiary" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setSearch("");
                }}
                placeholder={t("calendar.search")}
                className="w-full rounded-control inset-shadow-field border border-border bg-bg-secondary py-1.5 pl-9 pr-3 text-sm text-text transition-colors focus:border-accent"
              />
            </div>
            <ViewSegment view={view} onChange={setView} />
            <Button
              size="sm"
              type="button"
              onClick={() => newEvent()}
              icon={<Plus />}
            >
              {t("calendar.newEvent")}
            </Button>
          </div>
        </div>

        <div className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence initial={false} mode="popLayout" custom={direction}>
            <motion.div
              key={searching ? "search" : `${view}:${anchorIso}`}
              custom={direction}
              variants={{
                enter: (d: number) => ({ x: reduce ? 0 : d * 24, opacity: 0 }),
                center: { x: 0, opacity: 1 },
                exit: (d: number) => ({ x: reduce ? 0 : d * -24, opacity: 0 }),
              }}
              initial="enter"
              animate="center"
              exit="exit"
              transition={reduce ? TRANSITION_INSTANT : { duration: 0.18, ease: "easeOut" }}
              className="absolute inset-0"
            >
              {body}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>

      {popover && (
        <EventPopover
          occurrence={popover.occ}
          anchor={popover.rect}
          calendarName={calendars.find((c) => c.id === popover.occ.calendar_id)?.name}
          onClose={() => setPopover(null)}
          onEdit={(o) => {
            setPopover(null);
            setEditor({ mode: "edit", eventId: o.event_id, occurrenceKey: o.occurrence_key, occurrence: o });
          }}
          onDelete={(o) => {
            setPopover(null);
            void actions.deleteOccurrence(o);
          }}
        />
      )}
      <AnimatePresence>{editor && <EventDrawer key={editorKey(editor)} target={editor} onClose={() => setEditor(null)} />}</AnimatePresence>
      <AnimatePresence>{openTaskId && <TaskDrawer taskId={openTaskId} onClose={() => setOpenTaskId(null)} />}</AnimatePresence>
      {actions.dialogs}
    </div>
  );
}
