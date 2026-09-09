import { useTranslation } from "react-i18next";
import { useDroppable } from "@dnd-kit/core";
import { SortableContext, verticalListSortingStrategy } from "@dnd-kit/sortable";
import type { Task, TaskStatus } from "../../types";
import { NumberTween } from "../motion/NumberTween";
import { TaskCard } from "./TaskCard";
import { STATUS_KEY } from "./TaskStatusBadge";

const STRIP_CLASS: Record<TaskStatus, string> = {
  open: "bg-accent",
  in_progress: "bg-warning",
  done: "bg-success",
};

interface BoardColumnProps {
  status: TaskStatus;
  tasks: Task[];
  checkmarkIds: Set<string>;
  landedId: string | null;
  dragging: boolean;
  onContextMenu: (e: React.MouseEvent, task: Task) => void;
  /** True while the dragged card would land here. Comes from the board's drag
   *  preview rather than useDroppable's isOver, which stays false whenever the
   *  pointer is over one of the column's cards instead of its padding. */
  isDropTarget: boolean;
}

export function BoardColumn({ status, tasks, checkmarkIds, landedId, dragging, isDropTarget, onContextMenu }: BoardColumnProps) {
  const { t } = useTranslation();
  const { setNodeRef } = useDroppable({ id: status, data: { type: "column", status } });

  return (
    <div
      data-status={status}
      data-drop-target={isDropTarget || undefined}
      className={`flex flex-col min-w-0 flex-1 rounded-xl overflow-hidden transition-colors duration-150 ${
        isDropTarget ? "bg-accent/10 ring-2 ring-accent/40 ring-inset" : "bg-bg-secondary/40"
      }`}
    >
      {/* Every strip but the target's dims mid-drag, so the destination reads at a glance. */}
      <div
        className={`h-1 ${STRIP_CLASS[status]} transition-opacity duration-150 ${
          dragging && !isDropTarget ? "opacity-30" : "opacity-100"
        }`}
      />
      <div className="flex items-center gap-2 px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{t(STATUS_KEY[status])}</span>
        <span className="text-xs text-text-tertiary tabular-nums ml-auto">
          <NumberTween to={tasks.length} duration={300} />
        </span>
      </div>
      <div ref={setNodeRef} className="flex-1 min-h-[80px] overflow-y-auto px-2 pb-2">
        <SortableContext items={tasks.map((task) => task.id)} strategy={verticalListSortingStrategy}>
          {tasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              status={status}
              showCheckmark={checkmarkIds.has(task.id)}
              justLanded={landedId === task.id}
              boardDragging={dragging}
              onContextMenu={onContextMenu}
            />
          ))}
        </SortableContext>
      </div>
    </div>
  );
}
