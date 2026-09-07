import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ClipboardList, LayoutGrid, List, Plus, Search, X } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { useTask, useTasks } from "../../hooks/useTasks";
import { isDueToday, isOverdue } from "../../lib/tasks";
import { TaskList } from "./TaskList";
import { EmptyState } from "../ui/EmptyState";
import { LoadingCrossfade } from "../motion/LoadingCrossfade";
import { Skeleton } from "../ui/Skeleton";

type TaskFilter = "all" | "today" | "overdue";

export function TasksView() {
  const { t } = useTranslation();
  const tasksViewMode = useAppStore((s) => s.tasksViewMode);
  const setTasksViewMode = useAppStore((s) => s.setTasksViewMode);
  const openTaskId = useAppStore((s) => s.openTaskId);
  const setOpenTaskId = useAppStore((s) => s.setOpenTaskId);

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<TaskFilter>("all");

  const { data: tasks, isLoading } = useTasks();

  const openCount = useMemo(() => (tasks ?? []).filter((task) => task.status !== "done").length, [tasks]);

  const filteredTasks = useMemo(() => {
    const now = new Date();
    let list = tasks ?? [];
    const q = search.trim().toLowerCase();
    if (q) list = list.filter((task) => task.title.toLowerCase().includes(q));
    if (filter === "today") list = list.filter((task) => isDueToday(task, now));
    else if (filter === "overdue") list = list.filter((task) => isOverdue(task, now));
    return list;
  }, [tasks, search, filter]);

  const filters: { key: TaskFilter; label: string }[] = [
    { key: "all", label: t("tasks.filterAll") },
    { key: "today", label: t("tasks.filterToday") },
    { key: "overdue", label: t("tasks.filterOverdue") },
  ];

  return (
    <div className="flex flex-col h-full bg-surface">
      <div className="px-6 py-3 border-b border-border flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <ClipboardList className="w-4.5 h-4.5 text-accent" />
          <h1 className="text-base font-semibold text-text">{t("tasks.title")}</h1>
          {tasks && (
            <span className="text-xs text-text-tertiary">{t("tasks.openCount", { count: openCount })}</span>
          )}
        </div>

        <div className="flex-1 max-w-md relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("tasks.search")}
            className="w-full pl-9 pr-3 py-1.5 rounded-lg border border-border bg-bg-secondary text-text text-sm focus:border-accent transition-colors"
          />
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <div className="flex items-center rounded-lg border border-border bg-bg-secondary p-0.5">
            <button
              onClick={() => setTasksViewMode("board")}
              className={`p-1.5 rounded-md transition-colors ${
                tasksViewMode === "board" ? "bg-surface shadow-sm text-accent" : "text-text-tertiary hover:text-text-secondary"
              }`}
              title={t("tasks.board")}
              aria-label={t("tasks.board")}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
            <button
              onClick={() => setTasksViewMode("list")}
              className={`p-1.5 rounded-md transition-colors ${
                tasksViewMode === "list" ? "bg-surface shadow-sm text-accent" : "text-text-tertiary hover:text-text-secondary"
              }`}
              title={t("tasks.list")}
              aria-label={t("tasks.list")}
            >
              <List className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="flex items-center gap-1">
            {filters.map(({ key, label }) => (
              <button
                key={key}
                onClick={() => setFilter(key)}
                className={`px-2.5 py-1 rounded-md text-xs font-medium transition-colors ${
                  filter === key
                    ? "bg-accent/15 text-accent border border-accent/30"
                    : "bg-bg-secondary text-text-tertiary border border-transparent hover:text-text-secondary hover:bg-hover"
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <button
            onClick={() => setOpenTaskId("new")}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-accent text-white text-xs font-medium hover:bg-accent/90 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            {t("tasks.new")}
          </button>
        </div>
      </div>

      <LoadingCrossfade
        className="flex-1 min-h-0 flex flex-col"
        loading={isLoading}
        skeleton={
          <div className="p-4 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} height="2.5rem" rounded="lg" />
            ))}
          </div>
        }
      >
        {filteredTasks.length === 0 ? (
          <EmptyState
            icon={<ClipboardList className="w-10 h-10 text-text-tertiary" />}
            title={t("tasks.empty")}
            description={t("tasks.emptyDesc")}
          />
        ) : tasksViewMode === "list" ? (
          <TaskList tasks={filteredTasks} />
        ) : (
          // TaskBoard lands in Task 6; the list stands in for board mode until then.
          <TaskList tasks={filteredTasks} />
        )}
      </LoadingCrossfade>

      {openTaskId && <TaskDrawerPlaceholder taskId={openTaskId} onClose={() => setOpenTaskId(null)} />}
    </div>
  );
}

// Minimal stand-in for the real drawer; Task 7 replaces this with TaskDrawer.
function TaskDrawerPlaceholder({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const isNew = taskId === "new";
  const { data: detail } = useTask(isNew ? null : taskId);
  const title = isNew ? t("tasks.new") : (detail?.task.title ?? "");

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-surface border-l border-border shadow-lg z-50 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border">
        <h2 className="text-sm font-semibold text-text truncate">{title}</h2>
        <button
          onClick={onClose}
          className="text-text-tertiary hover:text-text transition-colors rounded-md p-1 hover:bg-hover"
          aria-label={t("common.close")}
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}
