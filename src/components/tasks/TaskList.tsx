import { useCallback, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { Link2, Paperclip } from "lucide-react";
import type { Task, TaskStatus } from "../../types";
import { TASK_STATUSES } from "../../types";
import { groupByStatus } from "../../lib/tasks";
import { useAppStore } from "../../stores/appStore";
import { useUpdateTask } from "../../hooks/useTasks";
import { TaskStatusBadge, STATUS_KEY } from "./TaskStatusBadge";
import { DueChip } from "./DueChip";
import { SPRING_SNAPPY, FADE_FAST } from "../motion/tokens";

// Above this many rows a flat map costs more DOM nodes than the browser
// tolerates smoothly; virtualize the same way MailList does.
const VIRTUALIZE_THRESHOLD = 200;

type ListItem =
  | { kind: "header"; status: TaskStatus; count: number }
  | { kind: "task"; task: Task };

interface TaskListProps {
  tasks: Task[];
}

export function TaskList({ tasks }: TaskListProps) {
  const { t } = useTranslation();
  const setOpenTaskId = useAppStore((s) => s.setOpenTaskId);
  const updateTask = useUpdateTask();
  const reduce = useReducedMotion();
  const listRef = useRef<HTMLDivElement>(null);

  const items = useMemo<ListItem[]>(() => {
    const grouped = groupByStatus(tasks);
    const out: ListItem[] = [];
    for (const status of TASK_STATUSES) {
      const group = grouped[status];
      if (group.length === 0) continue;
      out.push({ kind: "header", status, count: group.length });
      for (const task of group) out.push({ kind: "task", task });
    }
    return out;
  }, [tasks]);

  const toggleDone = useCallback((task: Task) => {
    updateTask.mutate({ id: task.id, patch: { status: task.status === "done" ? "open" : "done" } });
  }, [updateTask]);

  const virtualize = items.length > VIRTUALIZE_THRESHOLD;

  const rowVirtualizer = useVirtualizer({
    // count stays 0 in the non-virtualized path so its output is simply unused below.
    count: virtualize ? items.length : 0,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => (items[i]?.kind === "header" ? 32 : 52),
    overscan: 8,
  });

  function renderHeader(item: Extract<ListItem, { kind: "header" }>) {
    return (
      <div className="px-4 py-2 flex items-center gap-2 bg-bg-secondary/60">
        <TaskStatusBadge status={item.status} />
        <span className="text-xs text-text-tertiary tabular-nums">{item.count}</span>
      </div>
    );
  }

  function renderTask(item: Extract<ListItem, { kind: "task" }>) {
    const { task } = item;
    const done = task.status === "done";
    return (
      <div
        role="button"
        tabIndex={0}
        onClick={() => setOpenTaskId(task.id)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setOpenTaskId(task.id);
          }
        }}
        className="w-full flex items-center gap-3 px-4 py-2.5 border-b border-border-light hover:bg-hover transition-colors cursor-pointer"
      >
        <button
          onClick={(e) => { e.stopPropagation(); toggleDone(task); }}
          aria-label={t(done ? STATUS_KEY.open : STATUS_KEY.done)}
          className={`shrink-0 w-4.5 h-4.5 rounded-full border-[1.5px] flex items-center justify-center transition-colors ${
            done ? "border-accent bg-accent/10" : "border-text-tertiary/40 hover:border-accent"
          }`}
        >
          {done && (
            <svg viewBox="0 0 16 16" className="w-3 h-3 text-accent" fill="none">
              <motion.path
                d="M3 8.5L6.5 12L13 4.5"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ pathLength: 0 }}
                animate={{ pathLength: 1 }}
                transition={reduce ? { duration: 0 } : SPRING_SNAPPY}
              />
            </svg>
          )}
        </button>

        {task.priority !== "normal" && (
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${task.priority === "high" ? "bg-danger" : "bg-text-tertiary"}`} />
        )}

        <span
          className={`flex-1 min-w-0 truncate text-sm transition-colors duration-200 ${
            done ? "line-through text-text-tertiary" : "text-text"
          }`}
        >
          {task.title}
        </span>

        {task.checklist_total > 0 && (
          <span className="shrink-0 text-xs text-text-tertiary tabular-nums">
            {task.checklist_done}/{task.checklist_total}
          </span>
        )}

        {task.link_count > 0 && (
          <span className="shrink-0 flex items-center gap-1 text-xs text-text-tertiary">
            <Link2 className="w-3 h-3" />
            {task.link_count}
          </span>
        )}

        {task.attachment_count > 0 && (
          <span className="shrink-0 flex items-center gap-1 text-xs text-text-tertiary">
            <Paperclip className="w-3 h-3" />
            {task.attachment_count}
          </span>
        )}

        <DueChip task={task} className="shrink-0" />
      </div>
    );
  }

  if (!virtualize) {
    return (
      <div ref={listRef} className="flex-1 overflow-auto">
        <AnimatePresence initial={false}>
          {items.map((item) => (
            <motion.div
              key={item.kind === "header" ? `h-${item.status}` : item.task.id}
              layout={!reduce}
              exit={{ opacity: 0 }}
              transition={FADE_FAST}
            >
              {item.kind === "header" ? renderHeader(item) : renderTask(item)}
            </motion.div>
          ))}
        </AnimatePresence>
      </div>
    );
  }

  const virtualItems = rowVirtualizer.getVirtualItems();
  return (
    <div ref={listRef} className="flex-1 overflow-auto">
      <div style={{ height: rowVirtualizer.getTotalSize(), position: "relative" }}>
        {virtualItems.map((vItem) => {
          const item = items[vItem.index];
          return (
            <div
              key={vItem.key}
              data-index={vItem.index}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${vItem.start}px)` }}
            >
              {item.kind === "header" ? renderHeader(item) : renderTask(item)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
