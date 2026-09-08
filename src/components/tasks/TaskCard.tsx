import type { CSSProperties } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Link2, Paperclip } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task, TaskStatus } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { SpringCard } from "../motion/SpringCard";
import { GlowRing } from "../motion/GlowRing";
import { DueChip } from "./DueChip";
import { SPRING_SNAPPY } from "../motion/tokens";

// Copied from HoverLift's intensity-3 shadow — the drag ghost wants that exact
// weight without pulling BoardColumn/TaskCard into HoverLift's hover-only API.
const OVERLAY_SHADOW = "0 14px 40px rgba(15,23,42,.18)";

function TaskCardBody({ task }: { task: Task }) {
  return (
    <div className="p-3">
      <p className="text-sm font-medium text-text line-clamp-2">{task.title}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-text-tertiary">
        <DueChip task={task} />
        {task.priority !== "normal" && (
          <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${task.priority === "high" ? "bg-danger" : "bg-text-tertiary"}`} />
        )}
        {task.checklist_total > 0 && (
          <span className="flex items-center gap-1 text-xs tabular-nums">
            <GlowRing progress={task.checklist_done / task.checklist_total} size={18} />
            {task.checklist_done}/{task.checklist_total}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          {task.link_count > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <Link2 className="w-3 h-3" />
              {task.link_count}
            </span>
          )}
          {task.attachment_count > 0 && (
            <span className="flex items-center gap-1 text-xs">
              <Paperclip className="w-3 h-3" />
              {task.attachment_count}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function CheckmarkOverlay({ reduce }: { reduce: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-surface/90">
      <svg viewBox="0 0 24 24" className="w-8 h-8 text-success" fill="none">
        <motion.path
          d="M4 12.5L9.5 18L20 6"
          stroke="currentColor"
          strokeWidth={2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          initial={{ pathLength: 0 }}
          animate={{ pathLength: 1 }}
          transition={reduce ? { duration: 0 } : { duration: 0.3, ease: "easeOut" }}
        />
      </svg>
    </div>
  );
}

interface TaskCardProps {
  task: Task;
  status: TaskStatus;
  showCheckmark: boolean;
}

export function TaskCard({ task, status, showCheckmark }: TaskCardProps) {
  const reduce = useReducedMotion();
  const setOpenTaskId = useAppStore((s) => s.setOpenTaskId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: "card", status },
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.4 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <motion.div layout={!reduce && !isDragging} transition={SPRING_SNAPPY} className="mb-2">
        <SpringCard lift={4} glow={false} onClick={() => setOpenTaskId(task.id)} className="relative overflow-hidden">
          <TaskCardBody task={task} />
          {showCheckmark && <CheckmarkOverlay reduce={!!reduce} />}
        </SpringCard>
      </motion.div>
    </div>
  );
}

/** Static clone rendered inside DragOverlay — no sortable hooks, forced "lifted" look. */
export function TaskCardOverlay({ task }: { task: Task }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={false}
      animate={reduce ? {} : { scale: 1.03, rotate: 1.5 }}
      style={{ boxShadow: OVERLAY_SHADOW }}
      className="rounded-xl bg-surface border border-accent/40 cursor-grabbing overflow-hidden"
    >
      <TaskCardBody task={task} />
    </motion.div>
  );
}
