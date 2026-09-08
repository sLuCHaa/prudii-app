import { useEffect, useState } from "react";
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { parseISO } from "date-fns";
import { X, Trash2 } from "lucide-react";
import type { CreateTaskInput, Task, TaskPriority, TaskStatus, UpdateTaskPatch } from "../../types";
import { TASK_STATUSES } from "../../types";
import { useCreateTask, useDeleteTask, useTask, useTaskAttachments, useUpdateTask } from "../../hooks/useTasks";
import { useAppStore } from "../../stores/appStore";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useDebouncedCallback } from "../../hooks/useDebouncedCallback";
import { useDialog } from "../ui/DialogProvider";
import { Select, type SelectOption } from "../ui/Select";
import { Skeleton } from "../ui/Skeleton";
import { RichTextEditor } from "../editor/RichTextEditor";
import { STATUS_KEY } from "./TaskStatusBadge";
import { ChecklistEditor } from "./ChecklistEditor";
import { LinkedMails } from "./LinkedMails";
import { TaskFiles } from "./TaskFiles";
import { fromDatetimeLocalValue, quickDueDate, toDatetimeLocalValue } from "../../lib/tasks";
import { formatDateTime } from "../../lib/dateUtils";
import { SPRING_SNAPPY } from "../motion/tokens";

const PRIORITY_KEY: Record<TaskPriority, string> = {
  low: "tasks.priorityLow",
  normal: "tasks.priorityNormal",
  high: "tasks.priorityHigh",
};

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => {
      const base64 = (reader.result as string).split(",")[1];
      if (!base64) { reject(new Error("empty file")); return; }
      resolve(base64);
    };
    reader.readAsDataURL(file);
  });
}

function StatusSegment({ status, onChange }: { status: TaskStatus; onChange: (s: TaskStatus) => void }) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("tasks.status")} className="flex items-center gap-0.5 p-0.5 rounded-lg bg-bg-secondary">
      {TASK_STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          className="relative px-2.5 py-1 rounded-md text-xs font-medium"
        >
          {status === s && (
            <motion.div layoutId="task-status-pill" className="absolute inset-0 bg-surface shadow-sm rounded-md" transition={SPRING_SNAPPY} />
          )}
          <span className={`relative z-10 ${status === s ? "text-accent" : "text-text-tertiary"}`}>{t(STATUS_KEY[s])}</span>
        </button>
      ))}
    </div>
  );
}

function DueChips({ onPick }: { onPick: (iso: string) => void }) {
  const { t } = useTranslation();
  const chips: { key: "today" | "tomorrow" | "nextWeek"; label: string }[] = [
    { key: "today", label: t("tasks.today") },
    { key: "tomorrow", label: t("tasks.tomorrow") },
    { key: "nextWeek", label: t("tasks.nextWeek") },
  ];
  return (
    <div className="flex items-center gap-1.5">
      {chips.map((c) => (
        <button
          key={c.key}
          type="button"
          onClick={() => onPick(quickDueDate(c.key, new Date()))}
          className="px-2 py-0.5 rounded-full text-[11px] font-medium bg-bg-secondary text-text-secondary hover:bg-hover transition-colors"
        >
          {c.label}
        </button>
      ))}
    </div>
  );
}

interface TaskDrawerProps {
  taskId: string; // "new" for the create form, otherwise a real task id
  onClose: () => void;
  // Test-only overrides — production callers rely on the default hooks.
  onCreate?: (input: CreateTaskInput) => void;
  onUpdate?: (vars: { id: string; patch: UpdateTaskPatch }) => void;
}

export function TaskDrawer({ taskId, onClose, onCreate, onUpdate }: TaskDrawerProps) {
  const { t } = useTranslation();
  const isNew = taskId === "new";
  const setOpenTaskId = useAppStore((s) => s.setOpenTaskId);
  const addToast = useAppStore((s) => s.addToast);
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const { data: detail, isLoading, isError } = useTask(isNew ? null : taskId);
  const task: Task | null = detail?.task ?? null;

  const createTaskMutation = useCreateTask();
  const updateTaskMutation = useUpdateTask();
  const deleteTaskMutation = useDeleteTask();
  const attachmentsApi = useTaskAttachments(isNew ? null : taskId);
  const dialog = useDialog();

  const [descEscapeBlocked, setDescEscapeBlocked] = useState(false);
  // While the confirm dialog is up it owns Tab; two live traps bounce every Tab back.
  const drawerRef = useFocusTrap<HTMLElement>(!dialog.isOpen, { initialFocus: false });

  function patchTask(id: string, p: UpdateTaskPatch) {
    if (onUpdate) {
      onUpdate({ id, patch: p });
      return;
    }
    updateTaskMutation.mutate({ id, patch: p });
  }

  // The id travels as an explicit argument (not read from the `task` closure at
  // flush time) so a pending edit still lands on the task it was typed into, even
  // after switching to a different one before the debounce window elapses.
  const debouncedTitleSave = useDebouncedCallback((id: string, title: string) => {
    if (title.trim()) patchTask(id, { title });
  }, 400);
  const debouncedDescSave = useDebouncedCallback((id: string, html: string) => patchTask(id, { description_html: html }), 600);

  // Issue pending saves immediately rather than waiting for the exit animation
  // to finish unmounting the component (which would flush them too, just later).
  function closeDrawer() {
    debouncedTitleSave.flush();
    debouncedDescSave.flush();
    onClose();
  }

  // Deleting (or the task having vanished) makes a pending edit moot — drop it
  // instead of firing a doomed PATCH at a task that's gone.
  function discardAndClose() {
    debouncedTitleSave.cancel();
    debouncedDescSave.cancel();
    onClose();
  }

  useEffect(() => {
    // The confirm dialog renders outside the drawer, so its clicks read as
    // "outside" and its Escape would close the drawer underneath it.
    function handleMouseDown(e: MouseEvent) {
      if (dialog.isOpen) return;
      if (drawerRef.current && !drawerRef.current.contains(e.target as Node)) closeDrawer();
    }
    function handleKeyDown(e: KeyboardEvent) {
      // Overlays above the drawer (palette, shortcut help, quick-add popover) mark
      // the Escape they consume as handled.
      if (e.defaultPrevented || dialog.isOpen) return;
      if (e.key === "Escape" && !descEscapeBlocked) closeDrawer();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, descEscapeBlocked, dialog.isOpen, drawerRef, debouncedTitleSave, debouncedDescSave]);

  // The task vanished (deleted elsewhere) — bail out instead of showing a dead form forever.
  useEffect(() => {
    if (isNew || !isError) return;
    addToast("error", t("tasks.taskGone"));
    discardAndClose();
  }, [isNew, isError]);

  function submitCreate(rawTitle: string) {
    const title = rawTitle.trim();
    if (!title) return;
    const input: CreateTaskInput = { title };
    if (onCreate) {
      onCreate(input);
      return;
    }
    createTaskMutation.mutate(input, { onSuccess: (created) => setOpenTaskId(created.id) });
  }

  async function handleDelete() {
    if (!task) return;
    const confirmed = await dialog.danger({
      title: t("tasks.deleteConfirmTitle"),
      message: t("tasks.deleteConfirmBody"),
      confirmLabel: t("tasks.deleteTask"),
    });
    if (!confirmed) return;
    deleteTaskMutation.mutate(task.id);
    discardAndClose();
  }

  function handleDrop(e: DragEvent) {
    if (isNew || !task || !e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    Array.from(e.dataTransfer.files).forEach((file) => {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        addToast("error", t("tasks.fileTooLarge", { name: file.name }));
        return;
      }
      readFileAsBase64(file)
        .then((dataBase64) => attachmentsApi.addData.mutate({ filename: file.name, dataBase64 }))
        .catch(() => addToast("error", t("errors.attachmentOpen")));
    });
  }

  const priorityOptions: SelectOption[] = (["low", "normal", "high"] as TaskPriority[]).map((p) => ({
    value: p,
    label: t(PRIORITY_KEY[p]),
  }));

  return (
    <motion.aside
      ref={drawerRef}
      initial={{ x: 40, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 40, opacity: 0 }}
      transition={SPRING_SNAPPY}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={handleDrop}
      className="fixed top-8 bottom-0 right-0 w-[440px] max-w-[92vw] bg-surface border-l border-border shadow-2xl z-40 flex flex-col"
    >
      <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
        {!isNew && task ? (
          <StatusSegment status={task.status} onChange={(status) => patchTask(task.id, { status })} />
        ) : (
          <span className="text-sm font-semibold text-text">{t("tasks.new")}</span>
        )}
        <button
          onClick={closeDrawer}
          aria-label={t("common.close")}
          className="text-text-tertiary hover:text-text transition-colors rounded-md p-1 hover:bg-hover"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-4 py-4 space-y-5">
        {isNew ? (
          <input
            autoFocus
            placeholder={t("tasks.titlePlaceholder")}
            onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitCreate(e.currentTarget.value);
              }
            }}
            className="w-full text-lg font-semibold bg-transparent focus:outline-none text-text placeholder:text-text-tertiary"
          />
        ) : !task ? (
          <div className="space-y-3">
            <Skeleton height="1.75rem" width="70%" />
            <Skeleton height="8rem" />
            <Skeleton height="1.5rem" width="40%" />
          </div>
        ) : (
          <>
            <div className="flex items-center gap-2 flex-wrap">
              <Select
                value={task.priority}
                options={priorityOptions}
                onChange={(v) => patchTask(task.id, { priority: v as TaskPriority })}
                ariaLabel={t("tasks.priority")}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-border bg-bg-secondary text-text text-xs"
              />
              <input
                // Keyed on the stored value: uncontrolled while editing (no PATCH per
                // keystroke), yet remounted when the due date changes elsewhere.
                key={`due-${task.id}-${task.due_at ?? ""}`}
                type="datetime-local"
                defaultValue={toDatetimeLocalValue(task.due_at)}
                onBlur={(e) => {
                  const value = e.target.value;
                  if (value && value !== toDatetimeLocalValue(task.due_at)) {
                    patchTask(task.id, { due_at: fromDatetimeLocalValue(value) });
                  }
                }}
                onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                className="bg-bg-secondary border border-border rounded-lg px-2 py-1 text-xs text-text focus:border-accent"
              />
              {task.due_at && (
                <button
                  type="button"
                  onClick={() => patchTask(task.id, { clear_due_at: true })}
                  aria-label={t("tasks.clearDueDate")}
                  title={t("tasks.clearDueDate")}
                  className="p-1 rounded hover:bg-hover text-text-tertiary hover:text-danger transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            <DueChips onPick={(iso) => patchTask(task.id, { due_at: iso })} />

            <input
              key={task.id}
              defaultValue={task.title}
              placeholder={t("tasks.titlePlaceholder")}
              onChange={(e) => debouncedTitleSave(task.id, e.target.value)}
              onBlur={(e) => {
                debouncedTitleSave.cancel();
                const next = e.target.value.trim();
                if (!next) { e.target.value = task.title; return; }
                if (next !== task.title) patchTask(task.id, { title: next });
              }}
              onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => { if (e.key === "Enter") e.currentTarget.blur(); }}
              className="w-full text-lg font-semibold bg-transparent focus:outline-none text-text placeholder:text-text-tertiary"
            />

            <div>
              <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">{t("tasks.description")}</h3>
              <RichTextEditor
                key={task.id}
                content={task.description_html}
                onChange={(html) => debouncedDescSave(task.id, html)}
                placeholder={t("tasks.descriptionPlaceholder")}
                editorClassName="prose prose-sm max-w-none focus:outline-none min-h-[140px] text-text"
                toolbar
                onEscapeBlockedChange={setDescEscapeBlocked}
              />
            </div>

            <ChecklistEditor taskId={task.id} items={detail!.checklist} />
            <LinkedMails taskId={task.id} links={detail!.links} />
            <TaskFiles attachments={detail!.attachments} api={attachmentsApi} />
          </>
        )}
      </div>

      {!isNew && task && (
        <div className="px-4 py-3 border-t border-border shrink-0 flex items-center justify-between gap-2">
          <button
            onClick={handleDelete}
            className="flex items-center gap-1.5 text-xs font-medium text-danger hover:bg-danger/10 px-2 py-1 rounded-lg transition-colors"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {t("tasks.deleteTask")}
          </button>
          <div className="text-[11px] text-text-tertiary text-right leading-tight">
            <div>{t("tasks.createdAt", { date: formatDateTime(parseISO(task.created_at), use24h) })}</div>
            <div>{t("tasks.updatedAt", { date: formatDateTime(parseISO(task.updated_at), use24h) })}</div>
          </div>
        </div>
      )}
    </motion.aside>
  );
}
