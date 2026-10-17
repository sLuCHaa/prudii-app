import { createPortal } from "react-dom";
import { format } from "date-fns";
import type { Occurrence } from "../../types/calendar";
import type { Task } from "../../types";
import { dateLocale } from "../../lib/dateUtils";
import { useAppStore } from "../../stores/appStore";
import { EventChip } from "./EventChip";
import { TaskChip } from "./TaskChip";
import { occurrenceId, type CalendarGridHandlers } from "./gridShared";
import { usePopover } from "./usePopover";

interface DayListPopoverProps extends Pick<CalendarGridHandlers, "onOpen" | "onOpenTask" | "onToggleTask"> {
  day: Date;
  anchor: DOMRect;
  occurrences: Occurrence[];
  tasks: Task[];
  onClose: () => void;
}

export function DayListPopover({ day, anchor, occurrences, tasks, onClose, onOpen, onOpenTask, onToggleTask }: DayListPopoverProps) {
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const { ref, pos } = usePopover(anchor, onClose);
  return createPortal(
    <div ref={ref} role="dialog" tabIndex={-1} style={{ left: pos.left, top: pos.top }} className="fixed z-40 w-64 rounded-xl border border-border bg-surface p-2 shadow-2xl inset-shadow-edge outline-none">
      <div className="px-1.5 pb-1.5 text-xs font-semibold text-text">{format(day, "PPPP", { locale: dateLocale() })}</div>
      <div className="max-h-72 space-y-0.5 overflow-y-auto">
        {occurrences.map((o) => (
          <EventChip
            key={occurrenceId(o)}
            occurrence={o}
            variant={o.all_day ? "bar" : "dot"}
            use24h={use24h}
            onOpen={(occ, rect) => {
              onClose();
              onOpen(occ, rect);
            }}
          />
        ))}
        {tasks.map((task) => (
          <TaskChip key={task.id} task={task} use24h={use24h} onOpen={onOpenTask} onToggle={onToggleTask} />
        ))}
      </div>
    </div>,
    document.body,
  );
}
