import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useTranslation } from "react-i18next";
import { differenceInCalendarDays, format, isToday } from "date-fns";
import type { EventTimes, Occurrence } from "../../types/calendar";
import type { Task } from "../../types";
import { daySegment, isLaneEvent, isoDate, occurrenceRange, spanInDays } from "../../lib/calendar/dates";
import { layoutDay, layoutSpans, type Placement } from "../../lib/calendar/layout";
import { atMinutes, minutesFromOffset, resizedEnd, shiftTimed, SNAP_MINUTES, timedPayload } from "../../lib/calendar/drag";
import { dateLocale, formatTime } from "../../lib/dateUtils";
import { useAppStore } from "../../stores/appStore";
import { EventChip } from "./EventChip";
import { TaskChip } from "./TaskChip";
import { acceptsCalendarDrag, handleDayDrop, occurrenceId, tasksOnDay, type CalendarGridHandlers } from "./gridShared";

const HOUR_HEIGHT = 48;
const SCROLL_TO_HOUR = 7;
const LANE_PX = 22;
const HOURS = Array.from({ length: 24 }, (_, h) => h);

type Drag =
  | { kind: "create"; dayIdx: number; anchorMin: number; currentMin: number }
  | { kind: "move"; occ: Occurrence; rect: DOMRect; originDayIdx: number; originMin: number; dayIdx: number; min: number; moved: boolean }
  | { kind: "resize"; occ: Occurrence; dayIdx: number; endMin: number };

interface TimeGridProps extends CalendarGridHandlers {
  days: Date[];
  occurrences: Occurrence[];
  tasks: Task[];
  workStart: number;
  workEnd: number;
  workDays: number[];
  defaultDuration: number;
  onCreate: (times: EventTimes) => void;
}

export function TimeGrid({ days, occurrences, tasks, workStart, workEnd, workDays, defaultDuration, onCreate, ...handlers }: TimeGridProps) {
  const { t } = useTranslation();
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const scrollRef = useRef<HTMLDivElement>(null);
  const columnsRef = useRef<(HTMLDivElement | null)[]>([]);
  const dragRef = useRef<Drag | null>(null);
  const [drag, setDragState] = useState<Drag | null>(null);
  const [now, setNow] = useState(() => new Date());

  const setDrag = (d: Drag | null) => {
    dragRef.current = d;
    setDragState(d);
  };

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = SCROLL_TO_HOUR * HOUR_HEIGHT;
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  const columns = useMemo(
    () =>
      days.map((day) => {
        const segs = occurrences
          .filter((o) => !isLaneEvent(o))
          .flatMap((o) => {
            const seg = daySegment(o, day);
            return seg ? [{ o, seg }] : [];
          });
        const placement = layoutDay(segs.map(({ o, seg }) => ({ id: occurrenceId(o), startMin: seg.startMin, endMin: seg.endMin })));
        return segs.map((s) => ({ ...s, place: placement.get(occurrenceId(s.o)) ?? { col: 0, cols: 1 } }));
      }),
    [days, occurrences],
  );

  function hit(clientX: number, clientY: number): { dayIdx: number; min: number } | null {
    const cols = columnsRef.current.slice(0, days.length);
    let idx = cols.findIndex((el) => {
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return clientX >= r.left && clientX < r.right;
    });
    if (idx === -1) {
      const first = cols[0]?.getBoundingClientRect();
      if (!first) return null;
      idx = clientX < first.left ? 0 : cols.length - 1;
    }
    const rect = cols[idx]?.getBoundingClientRect();
    if (!rect) return null;
    return { dayIdx: idx, min: minutesFromOffset(clientY - rect.top, HOUR_HEIGHT) };
  }

  function finish(d: Drag) {
    if (d.kind === "create") {
      const day = days[d.dayIdx];
      const a = Math.min(d.anchorMin, d.currentMin);
      const b = Math.max(d.anchorMin, d.currentMin);
      const start = atMinutes(day, a);
      const end = b - a >= SNAP_MINUTES ? atMinutes(day, b) : new Date(start.getTime() + defaultDuration * 60_000);
      onCreate(timedPayload(start, end));
      return;
    }
    if (d.kind === "move") {
      if (!d.moved) {
        handlers.onOpen(d.occ, d.rect);
        return;
      }
      const { start, end } = occurrenceRange(d.occ);
      const moved = shiftTimed(start, end, differenceInCalendarDays(days[d.dayIdx], days[d.originDayIdx]), d.min - d.originMin);
      handlers.onMove(d.occ, timedPayload(moved.start, moved.end));
      return;
    }
    const { start } = occurrenceRange(d.occ);
    handlers.onMove(d.occ, timedPayload(start, resizedEnd(start, days[d.dayIdx], d.endMin)));
  }

  useEffect(() => {
    if (!drag) return;
    function onMove(e: PointerEvent) {
      const d = dragRef.current;
      const h = hit(e.clientX, e.clientY);
      if (!d || !h) return;
      if (d.kind === "create") setDrag({ ...d, currentMin: h.min });
      else if (d.kind === "move") setDrag({ ...d, dayIdx: h.dayIdx, min: h.min, moved: d.moved || h.dayIdx !== d.originDayIdx || h.min !== d.originMin });
      else setDrag({ ...d, dayIdx: h.dayIdx, endMin: h.min });
    }
    function onUp() {
      const d = dragRef.current;
      setDrag(null);
      if (d) finish(d);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    // Subscribe once per drag; the handlers read the live drag from the ref.
  }, [drag !== null]);

  function startCreate(e: ReactPointerEvent, dayIdx: number) {
    if (e.button !== 0 || e.target !== e.currentTarget) return;
    const h = hit(e.clientX, e.clientY);
    if (!h) return;
    e.preventDefault();
    setDrag({ kind: "create", dayIdx, anchorMin: h.min, currentMin: h.min });
  }

  function startMove(e: ReactPointerEvent<HTMLDivElement>, occ: Occurrence, dayIdx: number) {
    if (e.button !== 0) return;
    e.stopPropagation();
    const h = hit(e.clientX, e.clientY);
    if (!h) return;
    setDrag({ kind: "move", occ, rect: e.currentTarget.getBoundingClientRect(), originDayIdx: dayIdx, originMin: h.min, dayIdx, min: h.min, moved: false });
  }

  function startResize(e: ReactPointerEvent, occ: Occurrence, dayIdx: number, endMin: number) {
    if (e.button !== 0) return;
    e.stopPropagation();
    setDrag({ kind: "resize", occ, dayIdx, endMin });
  }

  function ghostFor(dayIdx: number): { startMin: number; endMin: number } | null {
    const d = drag;
    if (!d || d.dayIdx !== dayIdx) return null;
    if (d.kind === "create") {
      const a = Math.min(d.anchorMin, d.currentMin);
      return { startMin: a, endMin: Math.max(Math.max(d.anchorMin, d.currentMin), a + SNAP_MINUTES) };
    }
    if (d.kind === "move") {
      if (!d.moved) return null;
      const { start, end } = occurrenceRange(d.occ);
      const moved = shiftTimed(start, end, differenceInCalendarDays(days[d.dayIdx], days[d.originDayIdx]), d.min - d.originMin);
      return daySegment({ ...d.occ, start: moved.start.toISOString(), end: moved.end.toISOString() }, days[dayIdx]);
    }
    const { start } = occurrenceRange(d.occ);
    return daySegment({ ...d.occ, end: resizedEnd(start, days[d.dayIdx], d.endMin).toISOString() }, days[dayIdx]);
  }

  const dragging = drag?.kind === "move" || drag?.kind === "resize" ? drag.occ : null;
  const nowMin = now.getHours() * 60 + now.getMinutes();

  return (
    <div className="flex flex-col h-full min-h-0 select-none">
      <div className="flex shrink-0 border-b border-border overflow-y-hidden [scrollbar-gutter:stable]">
        <div className="w-14 shrink-0" />
        {days.map((d) => (
          <div key={isoDate(d)} className="flex-1 min-w-0 py-1.5 text-center">
            <div className="text-[11px] uppercase tracking-wide text-text-tertiary">{format(d, "EEE", { locale: dateLocale() })}</div>
            <div
              className={`mx-auto mt-0.5 w-7 h-7 grid place-items-center rounded-full text-sm font-semibold ${
                isToday(d) ? "bg-accent text-white" : "text-text"
              }`}
            >
              {d.getDate()}
            </div>
          </div>
        ))}
      </div>

      <AllDayLane days={days} occurrences={occurrences} tasks={tasks} use24h={use24h} label={t("calendar.allDay")} handlers={handlers} />

      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="relative flex" style={{ height: 24 * HOUR_HEIGHT }}>
          <div className="relative w-14 shrink-0">
            {HOURS.slice(1).map((h) => (
              <div key={h} className="absolute right-2 -translate-y-1/2 text-[10px] text-text-tertiary tabular-nums" style={{ top: h * HOUR_HEIGHT }}>
                {formatTime(atMinutes(days[0], h * 60), use24h)}
              </div>
            ))}
          </div>
          {days.map((day, dayIdx) => {
            const ghost = ghostFor(dayIdx);
            return (
              <div
                key={isoDate(day)}
                ref={(el) => {
                  columnsRef.current[dayIdx] = el;
                }}
                onPointerDown={(e) => startCreate(e, dayIdx)}
                className={`relative flex-1 min-w-0 border-l border-border ${workDays.includes(day.getDay()) ? "" : "bg-bg-secondary/40"}`}
              >
                {HOURS.map((h) => (
                  <div key={h} className="pointer-events-none absolute inset-x-0 border-t border-border/60" style={{ top: h * HOUR_HEIGHT }} />
                ))}
                <div
                  className="pointer-events-none absolute inset-x-0 bg-accent/[0.04]"
                  style={{ top: workStart * HOUR_HEIGHT, height: Math.max(0, workEnd - workStart) * HOUR_HEIGHT }}
                />
                {columns[dayIdx].map(({ o, seg, place }) => (
                  <TimedBlock
                    key={occurrenceId(o)}
                    occurrence={o}
                    seg={seg}
                    place={place}
                    use24h={use24h}
                    faded={dragging !== null && occurrenceId(dragging) === occurrenceId(o)}
                    untitled={t("calendar.untitled")}
                    onPointerDown={(e) => startMove(e, o, dayIdx)}
                    onResizeDown={(e) => startResize(e, o, dayIdx, seg.endMin)}
                    onKeyOpen={(rect) => handlers.onOpen(o, rect)}
                  />
                ))}
                {ghost && (
                  <div
                    className="pointer-events-none absolute inset-x-1 rounded-md border-2 border-dashed border-accent bg-accent/15"
                    style={{ top: (ghost.startMin / 60) * HOUR_HEIGHT, height: Math.max(((ghost.endMin - ghost.startMin) / 60) * HOUR_HEIGHT, 12) }}
                  />
                )}
                {isToday(day) && (
                  <div className="pointer-events-none absolute inset-x-0 h-0.5 bg-danger" style={{ top: (nowMin / 60) * HOUR_HEIGHT }}>
                    <span className="absolute -left-1 -top-1 w-2.5 h-2.5 rounded-full bg-danger" />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

interface TimedBlockProps {
  occurrence: Occurrence;
  seg: { startMin: number; endMin: number };
  place: Placement;
  use24h: boolean;
  faded: boolean;
  untitled: string;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onResizeDown: (e: ReactPointerEvent) => void;
  onKeyOpen: (rect: DOMRect) => void;
}

function TimedBlock({ occurrence: o, seg, place, use24h, faded, untitled, onPointerDown, onResizeDown, onKeyOpen }: TimedBlockProps) {
  const top = (seg.startMin / 60) * HOUR_HEIGHT;
  const height = Math.max(((seg.endMin - seg.startMin) / 60) * HOUR_HEIGHT, 18);
  const width = 100 / place.cols;
  const muted = o.status === "cancelled" || o.my_partstat === "declined";
  const { start, end } = occurrenceRange(o);
  return (
    <div
      role="button"
      tabIndex={0}
      onPointerDown={onPointerDown}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onKeyOpen(e.currentTarget.getBoundingClientRect());
        }
      }}
      className={`absolute overflow-hidden rounded-md border-l-[3px] px-1.5 py-0.5 text-[11px] leading-tight cursor-pointer ${faded ? "opacity-40" : ""} ${
        muted ? "opacity-60 line-through" : ""
      }`}
      style={{
        top,
        height,
        left: `calc(${place.col * width}% + 1px)`,
        width: `calc(${width}% - 2px)`,
        background: `color-mix(in srgb, ${o.color} 22%, var(--color-surface))`,
        borderLeftColor: o.color,
      }}
    >
      <div className="truncate font-medium text-text">{o.title || untitled}</div>
      {height > 30 && (
        <div className="truncate text-text-secondary tabular-nums">
          {formatTime(start, use24h)} – {formatTime(end, use24h)}
        </div>
      )}
      <div onPointerDown={onResizeDown} className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize" />
    </div>
  );
}

interface AllDayLaneProps {
  days: Date[];
  occurrences: Occurrence[];
  tasks: Task[];
  use24h: boolean;
  label: string;
  handlers: CalendarGridHandlers;
}

function AllDayLane({ days, occurrences, tasks, use24h, label, handlers }: AllDayLaneProps) {
  const [dropDay, setDropDay] = useState<string | null>(null);
  const spans = useMemo(
    () =>
      occurrences.filter(isLaneEvent).flatMap((o) => {
        const span = spanInDays(o, days);
        return span ? [{ o, ...span }] : [];
      }),
    [occurrences, days],
  );
  const lanes = useMemo(() => layoutSpans(spans.map((s) => ({ id: occurrenceId(s.o), startIdx: s.startIdx, endIdx: s.endIdx }))), [spans]);
  const laneCount = spans.reduce((m, s) => Math.max(m, (lanes.get(occurrenceId(s.o)) ?? 0) + 1), 0);
  const taskRows = days.reduce((m, d) => Math.max(m, tasksOnDay(tasks, d).length), 0);
  const height = Math.max(28, 6 + (laneCount + taskRows) * LANE_PX);
  const n = days.length;

  return (
    <div className="flex shrink-0 border-b border-border overflow-y-hidden [scrollbar-gutter:stable]">
      <div className="w-14 shrink-0 pt-1.5 pr-2 text-right text-[10px] text-text-tertiary">{label}</div>
      <div className="relative flex flex-1" style={{ minHeight: height }}>
        {days.map((day) => {
          const iso = isoDate(day);
          return (
            <div
              key={iso}
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
              className={`flex-1 min-w-0 border-l border-border px-0.5 ${dropDay === iso ? "bg-accent/10" : ""}`}
              style={{ paddingTop: 3 + laneCount * LANE_PX }}
            >
              {tasksOnDay(tasks, day).map((task) => (
                <TaskChip key={task.id} task={task} use24h={use24h} onOpen={handlers.onOpenTask} onToggle={handlers.onToggleTask} />
              ))}
            </div>
          );
        })}
        {spans.map((s) => (
          <div
            key={occurrenceId(s.o)}
            className="absolute px-0.5"
            style={{
              top: 3 + (lanes.get(occurrenceId(s.o)) ?? 0) * LANE_PX,
              left: `${(s.startIdx / n) * 100}%`,
              width: `${((s.endIdx - s.startIdx + 1) / n) * 100}%`,
            }}
          >
            <EventChip occurrence={s.o} variant="bar" use24h={use24h} onOpen={handlers.onOpen} />
          </div>
        ))}
      </div>
    </div>
  );
}
