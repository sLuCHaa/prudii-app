import { useTranslation } from "react-i18next";
import type { Task } from "../../types";
import { formatTime } from "../../lib/dateUtils";
import { TASK_MIME } from "./gridShared";

interface TaskChipProps {
  task: Task;
  use24h: boolean;
  onOpen: (task: Task) => void;
  onToggle: (task: Task) => void;
}

export function TaskChip({ task, use24h, onOpen, onToggle }: TaskChipProps) {
  const { t } = useTranslation();
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(TASK_MIME, task.id);
        e.dataTransfer.effectAllowed = "move";
      }}
      className="w-full min-w-0 h-5 flex items-center gap-1.5 px-1 rounded-md text-[11px] text-text hover:bg-hover"
    >
      <button
        type="button"
        aria-label={t("tasks.statusDone")}
        title={t("tasks.statusDone")}
        onClick={(e) => {
          e.stopPropagation();
          onToggle(task);
        }}
        className="w-3 h-3 shrink-0 rounded-full border border-text-tertiary hover:border-accent hover:bg-accent/20 transition-colors"
      />
      <button type="button" onClick={() => onOpen(task)} className="min-w-0 flex-1 flex items-center gap-1 text-left">
        {task.due_at && <span className="shrink-0 text-text-tertiary tabular-nums">{formatTime(new Date(task.due_at), use24h)}</span>}
        <span className="truncate">{task.title}</span>
      </button>
    </div>
  );
}
