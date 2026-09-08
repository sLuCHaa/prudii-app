import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2 } from "lucide-react";
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  KeyboardCode,
  closestCorners,
  useSensor,
  useSensors,
  defaultDropAnimationSideEffects,
  type DragStartEvent,
  type DragOverEvent,
  type DragEndEvent,
  type DropAnimation,
} from "@dnd-kit/core";
import { sortableKeyboardCoordinates } from "@dnd-kit/sortable";
import { useReducedMotion } from "motion/react";
import type { Task, TaskStatus } from "../../types";
import { TASK_STATUSES } from "../../types";
import { fullColumnDropIndex, groupByStatus } from "../../lib/tasks";
import { useMoveTask } from "../../hooks/useTasks";
import { BoardColumn } from "./BoardColumn";
import { TaskCardOverlay } from "./TaskCard";
import { EmptyState } from "../ui/EmptyState";
import { DaylightSky } from "../motion/DaylightSky";
import { CelebrationConfetti } from "../motion/CelebrationConfetti";

interface DragState {
  // null while a finished drop settles: the preview keeps rendering until the
  // mutation's cache write reaches us as a new `tasks` prop.
  activeId: string | null;
  preview: Task[];
}

function statusOf(id: string, list: Task[]): TaskStatus | undefined {
  return list.find((task) => task.id === id)?.status;
}

function resolveTargetStatus(overId: string, overData: unknown, list: Task[]): TaskStatus | undefined {
  const data = overData as { status?: TaskStatus } | undefined;
  if (data?.status) return data.status;
  if ((TASK_STATUSES as readonly string[]).includes(overId)) return overId as TaskStatus;
  return statusOf(overId, list);
}

// Enter is reserved for opening a card (TaskCard's onKeyDown); only Space starts
// a keyboard drag, otherwise dnd-kit's default codes fire on both keys.
const KEYBOARD_CODES = {
  start: [KeyboardCode.Space],
  cancel: [KeyboardCode.Esc],
  end: [KeyboardCode.Space, KeyboardCode.Tab],
};

interface TaskBoardProps {
  tasks: Task[];
  /** Unfiltered board contents — a drop index only means something against these. */
  allTasks: Task[];
}

export function TaskBoard({ tasks, allTasks }: TaskBoardProps) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const moveTask = useMoveTask();

  const [dragState, setDragState] = useState<DragState | null>(null);
  const [checkmarkIds, setCheckmarkIds] = useState<Set<string>>(new Set());
  const [celebrateTrigger, setCelebrateTrigger] = useState(0);
  const checkmarkTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  useEffect(() => {
    const timers = checkmarkTimers.current;
    return () => timers.forEach((timer) => clearTimeout(timer));
  }, []);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: KEYBOARD_CODES }),
  );

  // Nothing to resync explicitly: outside a drag we simply render straight from props.
  const renderTasks = dragState?.preview ?? tasks;
  const columns = useMemo(() => groupByStatus(renderTasks), [renderTasks]);

  // Driven by the settled prop (never the drag preview) so it can't fire mid-drag.
  const settled = useMemo(() => groupByStatus(tasks), [tasks]);
  const allDone = tasks.length > 0 && settled.open.length === 0 && settled.in_progress.length === 0;
  // Deferred while a checkmark plays out or a drag is live (e.g. pulling a card
  // back out of "done" needs the real open/in_progress columns as drop targets).
  const showAllDone = allDone && checkmarkIds.size === 0 && dragState === null;

  // Seeded with the mount-time value so an already-all-done board never fires the
  // confetti effect below on its first render — only a later false→true transition does.
  const wasShowingAllDone = useRef(showAllDone);
  useEffect(() => {
    if (showAllDone && !wasShowingAllDone.current) {
      setCelebrateTrigger((count) => count + 1);
    }
    wasShowingAllDone.current = showAllDone;
  }, [showAllDone]);

  // A prop update makes the local preview stale — mid-drag it would feed onDragEnd
  // old data, after a drop it is exactly the settled result we were waiting for.
  const tasksRef = useRef(tasks);
  useEffect(() => {
    if (dragState && tasksRef.current !== tasks) {
      setDragState(null);
    }
    tasksRef.current = tasks;
  }, [tasks, dragState]);

  function triggerCheckmark(id: string) {
    setCheckmarkIds((prev) => new Set(prev).add(id));
    const existing = checkmarkTimers.current.get(id);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      setCheckmarkIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
      checkmarkTimers.current.delete(id);
    }, reduce ? 0 : 300);
    checkmarkTimers.current.set(id, timer);
  }

  function handleDragStart(event: DragStartEvent) {
    setDragState({ activeId: String(event.active.id), preview: tasks });
  }

  function handleDragOver(event: DragOverEvent) {
    const { active, over } = event;
    if (!over) return;
    const activeId = String(active.id);
    const overId = String(over.id);
    if (activeId === overId) return;

    setDragState((prev) => {
      if (!prev) return prev;
      const list = prev.preview;
      const activeTask = list.find((task) => task.id === activeId);
      const targetStatus = resolveTargetStatus(overId, over.data.current, list);
      if (!activeTask || !targetStatus) return prev;

      const withoutActive = list.filter((task) => task.id !== activeId);
      const targetColumn = withoutActive.filter((task) => task.status === targetStatus);
      const overIndex = targetColumn.findIndex((task) => task.id === overId);
      const insertAt = overIndex >= 0 ? overIndex : targetColumn.length;

      const nextColumn = [...targetColumn];
      nextColumn.splice(insertAt, 0, { ...activeTask, status: targetStatus });
      const rest = withoutActive.filter((task) => task.status !== targetStatus);

      return { activeId: prev.activeId, preview: [...rest, ...nextColumn] };
    });
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    const activeId = String(active.id);
    const finalList = dragState?.preview ?? tasks;
    const finalStatus =
      statusOf(activeId, finalList) ?? (over ? resolveTargetStatus(String(over.id), over.data.current, finalList) : undefined);

    if (!finalStatus) {
      setDragState(null);
      return;
    }

    const columnTasks = finalList.filter((task) => task.status === finalStatus);
    const index = fullColumnDropIndex(allTasks, finalStatus, activeId, columnTasks);
    moveTask.mutate(
      { id: activeId, status: finalStatus, index },
      { onError: () => setDragState(null) },
    );

    const originalStatus = statusOf(activeId, tasks);
    if (finalStatus === "done" && originalStatus !== "done") {
      triggerCheckmark(activeId);
    }

    // Keep the preview on screen: clearing it here would render one frame from the
    // stale prop (the optimistic cache write only notifies on the next tick).
    setDragState({ activeId: null, preview: finalList });
  }

  function handleDragCancel() {
    setDragState(null);
  }

  const activeTask = dragState?.activeId ? renderTasks.find((task) => task.id === dragState.activeId) : undefined;
  const dropAnimation: DropAnimation = reduce
    ? { duration: 0, easing: "linear", sideEffects: defaultDropAnimationSideEffects({}) }
    : {
        duration: 220,
        easing: "cubic-bezier(0.18, 0.67, 0.6, 1.22)",
        sideEffects: defaultDropAnimationSideEffects({ styles: { active: { opacity: "0.4" } } }),
      };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCorners}
      onDragStart={handleDragStart}
      onDragOver={handleDragOver}
      onDragEnd={handleDragEnd}
      onDragCancel={handleDragCancel}
    >
      <div className="flex-1 min-h-0 flex gap-3 p-4 overflow-x-auto">
        {showAllDone ? (
          <div className="relative flex-[2] min-w-0 overflow-hidden rounded-xl bg-bg-secondary/40">
            <DaylightSky />
            <CelebrationConfetti trigger={celebrateTrigger} />
            <div className="relative z-10 h-full">
              <EmptyState
                icon={<CheckCircle2 className="w-10 h-10 text-success" />}
                title={t("tasks.allDone")}
                description={t("tasks.allDoneDesc")}
              />
            </div>
          </div>
        ) : (
          <>
            <BoardColumn status="open" tasks={columns.open} checkmarkIds={checkmarkIds} dragging={dragState !== null} />
            <BoardColumn status="in_progress" tasks={columns.in_progress} checkmarkIds={checkmarkIds} dragging={dragState !== null} />
          </>
        )}
        <BoardColumn status="done" tasks={columns.done} checkmarkIds={checkmarkIds} dragging={dragState !== null} />
      </div>
      <DragOverlay dropAnimation={dropAnimation}>{activeTask ? <TaskCardOverlay task={activeTask} /> : null}</DragOverlay>
    </DndContext>
  );
}
