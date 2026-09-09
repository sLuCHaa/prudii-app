import type { ReactNode } from "react";
import { CheckCircle2, Circle, CircleDashed, PanelRight, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Task, TaskStatus } from "../../types";
import { TASK_STATUSES } from "../../types";
import { ContextMenu } from "../ui/ContextMenu";
import type { MenuEntry } from "../../lib/menuModel";
import { STATUS_KEY } from "./TaskStatusBadge";

const STATUS_ICON: Record<TaskStatus, ReactNode> = {
  open: <Circle className="w-4 h-4" />,
  in_progress: <CircleDashed className="w-4 h-4" />,
  done: <CheckCircle2 className="w-4 h-4" />,
};

export interface TaskContextMenuProps {
  task: Task;
  x: number;
  y: number;
  onClose: () => void;
  onOpen: (task: Task) => void;
  /** Also fired for the status the task already has; callers treat that as a no-op. */
  onStatus: (task: Task, status: TaskStatus) => void;
  onDelete: (task: Task) => void;
}

/**
 * Right-click actions for a task, shared by the board and the list so the two
 * views can't drift apart.
 *
 * The three statuses sit flat rather than behind a submenu: with only three of
 * them a submenu costs a hop for no gain, and the check mark makes the current
 * one readable at a glance.
 */
export function TaskContextMenu({ task, x, y, onClose, onOpen, onStatus, onDelete }: TaskContextMenuProps) {
  const { t } = useTranslation();

  const entries: MenuEntry[] = [
    { kind: "item", id: "open", label: t("tasks.openTask"), icon: <PanelRight className="w-4 h-4" />, onSelect: () => onOpen(task) },
    { kind: "separator" },
    ...TASK_STATUSES.map((status): MenuEntry => ({
      kind: "item",
      id: `status-${status}`,
      label: t(STATUS_KEY[status]),
      icon: STATUS_ICON[status],
      // Checked, not disabled: greying the current status reads as "unavailable"
      // rather than "this is the one you are on".
      selected: task.status === status,
      onSelect: () => onStatus(task, status),
    })),
    { kind: "separator" },
    { kind: "item", id: "delete", label: t("tasks.deleteTask"), icon: <Trash2 className="w-4 h-4" />, danger: true, onSelect: () => onDelete(task) },
  ];

  return <ContextMenu entries={entries} x={x} y={y} onClose={onClose} ariaLabel={task.title} />;
}
