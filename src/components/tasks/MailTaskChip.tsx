import { useTranslation } from "react-i18next";
import { ClipboardList } from "lucide-react";
import type { Task, TaskStatus } from "../../types";
import { Tooltip } from "../ui/Tooltip";
import { useAppStore } from "../../stores/appStore";

interface MailTaskChipProps {
  count: number;
}

/** Mail-list marker: how many tasks this email is linked to. */
export function MailTaskChip({ count }: MailTaskChipProps) {
  const { t } = useTranslation();
  if (count <= 0) return null;
  const label = t("tasks.linkedCount", { count });
  return (
    <Tooltip label={label}>
      <span aria-label={label} className="flex items-center gap-0.5 text-accent">
        <ClipboardList className="w-3 h-3" />
        <span className="text-[11px] leading-none tabular-nums">{count}</span>
      </span>
    </Tooltip>
  );
}

const STATUS_DOT: Record<TaskStatus, string> = {
  open: "bg-text-tertiary",
  in_progress: "bg-accent",
  done: "bg-success",
};

interface LinkedTaskChipProps {
  task: Task;
}

/** Thread header marker: one chip per linked task, opens it in the task drawer. */
export function LinkedTaskChip({ task }: LinkedTaskChipProps) {
  const { t } = useTranslation();
  const openTaskById = useAppStore((s) => s.openTaskById);
  return (
    <button
      type="button"
      onClick={() => openTaskById(task.id)}
      title={t("tasks.openTask")}
      className="flex max-w-[220px] items-center gap-1.5 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent transition-colors hover:bg-hover"
    >
      <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${STATUS_DOT[task.status]}`} />
      <span className="truncate">{task.title}</span>
    </button>
  );
}
