import type { DragEvent } from "react";
import { differenceInCalendarDays, isSameDay } from "date-fns";
import type { EventTimes, Occurrence } from "../../types/calendar";
import type { Task } from "../../types";
import { occurrenceRange } from "../../lib/calendar/dates";
import { allDayPayload, shiftAllDay, shiftTimed, timedPayload } from "../../lib/calendar/drag";

export const OCCURRENCE_MIME = "application/x-prudii-occurrence";
export const TASK_MIME = "application/x-prudii-task";

export interface CalendarGridHandlers {
  onOpen: (o: Occurrence, rect: DOMRect) => void;
  onMove: (o: Occurrence, times: EventTimes) => void;
  onOpenTask: (task: Task) => void;
  onToggleTask: (task: Task) => void;
  onMoveTask: (task: Task, day: Date) => void;
}

export function occurrenceId(o: Occurrence): string {
  return `${o.event_id}|${o.occurrence_key}`;
}

export function tasksOnDay(tasks: Task[], day: Date): Task[] {
  return tasks.filter((task) => task.due_at && isSameDay(new Date(task.due_at), day));
}

export function acceptsCalendarDrag(e: DragEvent): boolean {
  const types = Array.from(e.dataTransfer.types);
  return types.includes(OCCURRENCE_MIME) || types.includes(TASK_MIME);
}

/** Moves a dropped event or task to `day`, keeping its time of day and length. */
export function handleDayDrop(
  e: DragEvent,
  day: Date,
  occurrences: Occurrence[],
  tasks: Task[],
  handlers: Pick<CalendarGridHandlers, "onMove" | "onMoveTask">,
) {
  e.preventDefault();
  const taskId = e.dataTransfer.getData(TASK_MIME);
  if (taskId) {
    const task = tasks.find((x) => x.id === taskId);
    if (task) handlers.onMoveTask(task, day);
    return;
  }
  const id = e.dataTransfer.getData(OCCURRENCE_MIME);
  const o = occurrences.find((x) => occurrenceId(x) === id);
  if (!o) return;
  const { start, end } = occurrenceRange(o);
  const days = differenceInCalendarDays(day, start);
  if (days === 0) return;
  if (o.all_day) {
    const moved = shiftAllDay(o.start, o.end, days);
    handlers.onMove(o, allDayPayload(moved.start, moved.end));
  } else {
    const moved = shiftTimed(start, end, days, 0);
    handlers.onMove(o, timedPayload(moved.start, moved.end));
  }
}
