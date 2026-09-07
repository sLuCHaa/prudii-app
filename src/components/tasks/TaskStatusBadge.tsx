import { useTranslation } from "react-i18next";
import type { TaskStatus } from "../../types";

const STATUS_KEY: Record<TaskStatus, string> = {
  open: "tasks.statusOpen",
  in_progress: "tasks.statusInProgress",
  done: "tasks.statusDone",
};

const STATUS_CLASS: Record<TaskStatus, string> = {
  open: "bg-bg-secondary text-text-secondary",
  in_progress: "bg-accent/10 text-accent",
  done: "bg-success/10 text-success",
};

interface TaskStatusBadgeProps {
  status: TaskStatus;
  className?: string;
}

export function TaskStatusBadge({ status, className = "" }: TaskStatusBadgeProps) {
  const { t } = useTranslation();
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium uppercase tracking-wide ${STATUS_CLASS[status]} ${className}`}>
      {t(STATUS_KEY[status])}
    </span>
  );
}
