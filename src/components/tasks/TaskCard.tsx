import type { CSSProperties, KeyboardEvent, MouseEvent } from "react";
import { motion, useReducedMotion } from "motion/react";
import { Link2, Paperclip } from "lucide-react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task, TaskStatus } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { SpringCard } from "../motion/SpringCard";
import { GlowRing } from "../motion/GlowRing";
import { DueChip } from "./DueChip";
import { SPRING_BOUNCY, SPRING_SNAPPY } from "../motion/tokens";

// One step heavier than HoverLift's intensity-3 shadow: the dragged clone has to
// read as lifted off the board, not merely hovered.
const OVERLAY_SHADOW = "0 18px 48px rgba(15,23,42,.26)";

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

const LANDED_RING: Record<TaskStatus, string> = {
  open: "ring-accent",
  in_progress: "ring-warning",
  done: "ring-success",
};

/** One-shot ring in the destination's colour, so a card that lands in a new
 *  column is visibly the one that just moved. */
function LandingPulse({ status, reduce }: { status: TaskStatus; reduce: boolean }) {
  return (
    <motion.span
      aria-hidden
      className={`pointer-events-none absolute inset-0 rounded-xl ring-2 ring-inset ${LANDED_RING[status]}`}
      initial={{ opacity: reduce ? 0 : 0.9 }}
      animate={{ opacity: 0 }}
      transition={reduce ? { duration: 0 } : { duration: 0.45, ease: "easeOut" }}
    />
  );
}

interface TaskCardProps {
  task: Task;
  status: TaskStatus;
  showCheckmark: boolean;
  /** True for one beat after this card was dropped into a different column. */
  justLanded: boolean;
  /** Right-click actions; the board owns the menu so it can animate the result. */
  onContextMenu?: (e: MouseEvent, task: Task) => void;
  /** True while any card on the board is being dragged — suppresses FLIP layout
   *  animation on every card so it can't compound with dnd-kit's own transform. */
  boardDragging: boolean;
}

export function TaskCard({ task, status, showCheckmark, justLanded, boardDragging, onContextMenu }: TaskCardProps) {
  const reduce = useReducedMotion();
  const setOpenTaskId = useAppStore((s) => s.setOpenTaskId);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: "card", status },
  });

  const style: CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
  };

  // Space stays dnd-kit's drag activator (TaskBoard's keyboardCodes); Enter opens
  // instead, guarded to this element so a future nested control can't bubble it up.
  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "Enter" && e.target === e.currentTarget) {
      e.preventDefault();
      setOpenTaskId(task.id);
      return;
    }
    listeners?.onKeyDown?.(e);
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      onKeyDown={handleKeyDown}
      onContextMenu={onContextMenu && ((e) => onContextMenu(e, task))}
    >
      <motion.div layout={!reduce && !boardDragging} transition={SPRING_SNAPPY} className="mb-2">
        {isDragging ? (
          // The row the card came from stays as a dashed gap of the exact same
          // height (hidden body, not a guessed size), so the board never reflows
          // under the cursor mid-drag.
          <div className="rounded-xl border-2 border-dashed border-accent/50 bg-accent/5">
            <div className="invisible">
              <TaskCardBody task={task} />
            </div>
          </div>
        ) : (
          <SpringCard lift={4} glow={false} onClick={() => setOpenTaskId(task.id)} className="relative overflow-hidden">
            <TaskCardBody task={task} />
            {justLanded && <LandingPulse status={status} reduce={!!reduce} />}
            {showCheckmark && <CheckmarkOverlay reduce={!!reduce} />}
          </SpringCard>
        )}
      </motion.div>
    </div>
  );
}

/** Rendered inside DragOverlay — SpringCard's hover glow can't apply to a clone
 *  that's already lifted, so the "picked up" look is applied directly instead. */
export function TaskCardOverlay({ task }: { task: Task }) {
  const reduce = useReducedMotion();
  return (
    <motion.div
      initial={reduce ? false : { scale: 1, rotate: 0 }}
      animate={reduce ? {} : { scale: 1.05, rotate: 2 }}
      transition={SPRING_BOUNCY}
      style={{ boxShadow: OVERLAY_SHADOW }}
      className="rounded-xl bg-surface ring-2 ring-accent/60 cursor-grabbing overflow-hidden"
    >
      <TaskCardBody task={task} />
    </motion.div>
  );
}
