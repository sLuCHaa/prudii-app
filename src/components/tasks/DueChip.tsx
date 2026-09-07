import { useTranslation } from "react-i18next";
import type { Task } from "../../types";
import { isOverdue, isDueToday } from "../../lib/tasks";

function isTomorrow(due: Date, now: Date): boolean {
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return due.getFullYear() === t.getFullYear() && due.getMonth() === t.getMonth() && due.getDate() === t.getDate();
}

interface DueChipProps {
  task: Pick<Task, "due_at" | "status">;
  now?: Date;
  className?: string;
}

export function DueChip({ task, now, className = "" }: DueChipProps) {
  const { t, i18n } = useTranslation();
  if (!task.due_at) return null;

  const reference = now ?? new Date();
  const due = new Date(task.due_at);
  const overdue = isOverdue(task, reference);
  const dueToday = isDueToday(task, reference);
  const dueTomorrow = !overdue && !dueToday && isTomorrow(due, reference);

  const label = overdue
    ? t("tasks.overdue")
    : dueToday
      ? t("tasks.today")
      : dueTomorrow
        ? t("tasks.tomorrow")
        : new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }).format(due);

  const colorClass = overdue ? "text-danger" : dueToday ? "text-warning" : "text-text-tertiary";

  return <span className={`text-xs whitespace-nowrap ${colorClass} ${className}`}>{label}</span>;
}
