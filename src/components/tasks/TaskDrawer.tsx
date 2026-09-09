import { useEffect, useRef, useState } from "react";
import type { DragEvent, KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "motion/react";
import { format, formatDistanceToNowStrict, parseISO } from "date-fns";
import { CalendarDays, X } from "lucide-react";
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
import { TaskSectionHead } from "./TaskSectionHead";
import { fromDatetimeLocalValue, isOverdue, quickDueDate, toDatetimeLocalValue } from "../../lib/tasks";
import { dateLocale, formatDateTime, formatTime } from "../../lib/dateUtils";
import { ENTRANCE, SPRING_SNAPPY, TRANSITION_INSTANT } from "../motion/tokens";

const PRIORITY_KEY: Record<TaskPriority, string> = {
  low: "tasks.priorityLow",
  normal: "tasks.priorityNormal",
  high: "tasks.priorityHigh",
};

const PRIORITY_DOT: Record<TaskPriority, string> = {
  low: "bg-text-tertiary",
  normal: "bg-accent",
  high: "bg-danger",
};

const STATUS_STRIPE: Record<TaskStatus, string> = {
  open: "bg-accent",
  in_progress: "bg-warning",
  done: "bg-success",
};

const PILL = "inline-flex items-center gap-2 h-[30px] px-3 rounded-full border border-border bg-bg-secondary text-text text-xs font-medium hover:border-text-tertiary transition-colors";

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
    <div role="group" aria-label={t("tasks.status")} className="inline-flex items-center gap-0.5 p-0.5 rounded-full bg-bg-tertiary">
      {TASK_STATUSES.map((s) => (
        <button
          key={s}
          type="button"
          onClick={() => onChange(s)}
          aria-pressed={status === s}
          className="relative px-2.5 py-1 rounded-full text-xs font-medium"
        >
          {status === s && (
            <motion.div layoutId="task-status-pill" className="absolute inset-0 bg-surface shadow-sm rounded-full" transition={SPRING_SNAPPY} />
          )}
          <span className={`relative z-10 ${status === s ? "text-text" : "text-text-secondary"}`}>{t(STATUS_KEY[s])}</span>
        </button>
      ))}
    </div>
  );
}

/** Section wrapper: staggered rise, matching the drawer's entrance rhythm. */
function Section({ index, children }: { index: number; children: ReactNode }) {
  const reduce = useReducedMotion();
  return (
    <motion.section
      initial={reduce ? false : { y: ENTRANCE.y, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={reduce ? TRANSITION_INSTANT : { duration: ENTRANCE.duration, delay: 0.04 + index * 0.05, ease: "easeOut" }}
    >
      {children}
    </motion.section>
  );
}

type QuickKey = "today" | "tomorrow" | "nextWeek";

function DuePopover({
  dueAt,
  use24h,
  onPick,
  onClear,
  onClose,
}: {
  dueAt: string | null;
  use24h: boolean;
  onPick: (iso: string) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const ref = useFocusTrap<HTMLDivElement>(true);
  const [value, setValue] = useState(() => toDatetimeLocalValue(dueAt));

  const quick: { key: QuickKey; label: string; iso: string }[] = (["today", "tomorrow", "nextWeek"] as QuickKey[]).map((key) => ({
    key,
    label: t(`tasks.${key}`),
    iso: quickDueDate(key, new Date()),
  }));

  function subLabel(key: QuickKey, iso: string): string {
    const d = new Date(iso);
    const time = formatTime(d, use24h);
    if (key !== "nextWeek") return time;
    return `${format(d, "EEE", { locale: dateLocale() })} ${time}`;
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("tasks.due")}
      data-due-popover
      className="absolute top-full left-0 mt-2 z-30 w-66 max-w-full p-2 rounded-2xl bg-surface border border-border shadow-lg"
    >
      <div className="grid grid-cols-2 gap-1.5 mb-2">
        {quick.map((q) => (
          <button
            key={q.key}
            type="button"
            onClick={() => { onPick(q.iso); onClose(); }}
            className="flex items-center justify-between gap-2 px-2.5 py-2 rounded-xl bg-bg-secondary text-xs font-medium text-text hover:bg-accent/10 hover:text-accent transition-colors text-left"
          >
            <span>{q.label}</span>
            <span className="text-text-tertiary font-normal tabular-nums">{subLabel(q.key, q.iso)}</span>
          </button>
        ))}
        <button
          type="button"
          onClick={() => { onClear(); onClose(); }}
          className="px-2.5 py-2 rounded-xl bg-bg-secondary text-xs font-medium text-text hover:bg-accent/10 hover:text-accent transition-colors text-left"
        >
          {t("tasks.dueNoDate")}
        </button>
      </div>

      <label htmlFor="task-due-input" className="block px-1 mb-1 text-[11px] uppercase tracking-wider text-text-tertiary">
        {t("tasks.dueDateTime")}
      </label>
      <input
        id="task-due-input"
        type="datetime-local"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e: ReactKeyboardEvent<HTMLInputElement>) => {
          if (e.key !== "Enter" || !value) return;
          e.preventDefault();
          onPick(fromDatetimeLocalValue(value));
          onClose();
        }}
        className="w-full h-9 px-2.5 rounded-xl border border-border bg-bg-secondary text-text text-xs focus:border-accent transition-colors"
      />

      <div className="flex items-center justify-between mt-2 px-1">
        <button type="button" onClick={onClose} className="text-xs text-text-secondary hover:text-text transition-colors py-1">
          {t("common.cancel")}
        </button>
        <button
          type="button"
          disabled={!value}
          onClick={() => { onPick(fromDatetimeLocalValue(value)); onClose(); }}
          className="text-xs font-semibold text-accent hover:text-accent-hover transition-colors py-1 disabled:opacity-40"
        >
          {t("tasks.dueApply")}
        </button>
      </div>
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
  const { data: detail, isError } = useTask(isNew ? null : taskId);
  const task: Task | null = detail?.task ?? null;

  const createTaskMutation = useCreateTask();
  const updateTaskMutation = useUpdateTask();
  const deleteTaskMutation = useDeleteTask();
  const attachmentsApi = useTaskAttachments(isNew ? null : taskId);
  const dialog = useDialog();
  const reduce = useReducedMotion();

  const [descEscapeBlocked, setDescEscapeBlocked] = useState(false);
  const [duePopoverOpen, setDuePopoverOpen] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const dueChipRef = useRef<HTMLButtonElement>(null);
  // While the confirm dialog is up it owns Tab; two live traps bounce every Tab back.
  const drawerRef = useFocusTrap<HTMLElement>(!dialog.isOpen, { initialFocus: false });

  function patchTask(id: string, p: UpdateTaskPatch) {
    if (onUpdate) {
      onUpdate({ id, patch: p });
      return;
    }
    updateTaskMutation.mutate({ id, patch: p });
  }

  // The `task` prop lags a just-sent PATCH, so remember what we wrote: an
  // outside click flushes the debounce and then blurs, which must not write again.
  const lastSavedTitle = useRef<{ id: string; title: string } | null>(null);
  function saveTitle(id: string, title: string) {
    lastSavedTitle.current = { id, title };
    patchTask(id, { title });
  }

  // The id travels as an explicit argument (not read from the `task` closure at
  // flush time) so a pending edit still lands on the task it was typed into, even
  // after switching to a different one before the debounce window elapses.
  const debouncedTitleSave = useDebouncedCallback((id: string, title: string) => {
    const next = title.trim();
    if (next) saveTitle(id, next);
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
      const target = e.target as Element;
      if (
        duePopoverOpen &&
        !dueChipRef.current?.contains(target) &&
        !target.closest?.("[data-due-popover]")
      ) {
        setDuePopoverOpen(false);
      }
      // ContextMenu (and the priority Select's listbox) portals to <body>, so its
      // options land outside the drawer without being an outside click.
      if (target.closest?.('[role="listbox"],[role="menu"]')) return;
      if (drawerRef.current && !drawerRef.current.contains(target)) closeDrawer();
    }
    function handleKeyDown(e: KeyboardEvent) {
      // Overlays above the drawer (palette, shortcut help, quick-add popover) mark
      // the Escape they consume as handled.
      if (e.defaultPrevented || dialog.isOpen) return;
      if (e.key !== "Escape" || descEscapeBlocked) return;
      if (duePopoverOpen) { setDuePopoverOpen(false); return; }
      closeDrawer();
    }
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose, descEscapeBlocked, dialog.isOpen, duePopoverOpen, drawerRef, debouncedTitleSave, debouncedDescSave]);

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
    setDropActive(false);
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
    icon: <span className={`w-2 h-2 rounded-full shrink-0 ${PRIORITY_DOT[p]}`} />,
  }));

  function dueLabel(due: string): string {
    const d = new Date(due);
    const now = new Date();
    const sameDay = (a: Date, b: Date) =>
      a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const day = sameDay(d, now)
      ? t("tasks.today")
      : sameDay(d, tomorrow)
        ? t("tasks.tomorrow")
        : format(d, "d MMM", { locale: dateLocale() });
    return `${day}, ${formatTime(d, use24h)}`;
  }

  // Sections are conditional (linked mails), so the stagger counts what actually renders.
  let rendered = 0;
  const sectionIndex = () => rendered++;

  const overdue = task ? isOverdue(task, new Date()) : false;
  const stripeClass = task ? STATUS_STRIPE[task.status] : "bg-accent";

  return (
    <>
      <motion.div
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={reduce ? TRANSITION_INSTANT : { duration: 0.2, ease: "easeOut" }}
        // Absolute inside the tasks view: the sidebar stays clickable, so one click there
        // closes the drawer and navigates.
        className="absolute inset-0 z-30 drawer-backdrop"
      />
      <motion.aside
        ref={drawerRef}
        aria-label={t("tasks.title")}
        initial={reduce ? false : { x: 28, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={reduce ? { opacity: 0 } : { x: 28, opacity: 0 }}
        transition={reduce ? TRANSITION_INSTANT : SPRING_SNAPPY}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes("Files")) return;
          e.preventDefault();
          setDropActive(true);
        }}
        onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDropActive(false); }}
        onDrop={handleDrop}
        className="fixed top-8 bottom-0 right-0 w-[480px] max-w-[92vw] bg-surface border-l border-border shadow-2xl z-40 flex flex-col"
      >
        <div className={`h-[3px] shrink-0 transition-colors duration-300 ${stripeClass}`} />

        <div className="shrink-0 grid gap-3 px-5 pt-4 pb-3">
          <div className="flex items-center justify-between gap-2">
            {!isNew && task ? (
              <StatusSegment status={task.status} onChange={(status) => patchTask(task.id, { status })} />
            ) : (
              <span className="font-heading text-sm font-bold text-text">{t("tasks.new")}</span>
            )}
            <button
              onClick={closeDrawer}
              aria-label={t("common.close")}
              className="w-[30px] h-[30px] grid place-items-center rounded-lg text-text-tertiary hover:bg-hover hover:text-text transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

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
              className="w-full font-heading text-[22px] font-bold leading-tight bg-transparent focus:outline-none text-text placeholder:text-text-tertiary"
            />
          ) : !task ? (
            <div className="space-y-3">
              <Skeleton height="1.75rem" width="70%" />
              <Skeleton height="1.5rem" width="40%" />
            </div>
          ) : (
            <>
              <textarea
                key={task.id}
                rows={1}
                spellCheck={false}
                ref={autoGrow}
                defaultValue={task.title}
                aria-label={t("tasks.titlePlaceholder")}
                placeholder={t("tasks.titlePlaceholder")}
                onChange={(e) => { autoGrow(e.currentTarget); debouncedTitleSave(task.id, e.target.value); }}
                onBlur={(e) => {
                  debouncedTitleSave.cancel();
                  const next = e.target.value.trim();
                  if (!next) { e.target.value = task.title; autoGrow(e.currentTarget); return; }
                  const saved = lastSavedTitle.current?.id === task.id ? lastSavedTitle.current.title : task.title;
                  if (next !== saved) saveTitle(task.id, next);
                }}
                onKeyDown={(e: ReactKeyboardEvent<HTMLTextAreaElement>) => { if (e.key === "Enter") { e.preventDefault(); e.currentTarget.blur(); } }}
                className="w-full resize-none overflow-hidden font-heading text-[22px] font-bold leading-tight bg-transparent focus:outline-none text-text placeholder:text-text-tertiary"
              />

              <div className="relative flex flex-wrap items-center gap-2">
                <Select
                  value={task.priority}
                  options={priorityOptions}
                  onChange={(v) => patchTask(task.id, { priority: v as TaskPriority })}
                  ariaLabel={t("tasks.priority")}
                  className={PILL}
                />
                <button
                  ref={dueChipRef}
                  type="button"
                  onClick={() => setDuePopoverOpen((open) => !open)}
                  aria-haspopup="dialog"
                  aria-expanded={duePopoverOpen}
                  aria-label={t("tasks.due")}
                  className={
                    task.due_at
                      ? `inline-flex items-center gap-2 h-[30px] px-3 rounded-full border border-transparent text-xs font-medium transition-colors ${overdue ? "bg-danger/10 text-danger" : "bg-accent/10 text-accent"}`
                      : "inline-flex items-center gap-2 h-[30px] px-3 rounded-full border border-dashed border-border bg-transparent text-xs font-medium text-text-tertiary hover:border-text-tertiary hover:text-text-secondary transition-colors"
                  }
                >
                  <CalendarDays className="w-3.5 h-3.5" />
                  {task.due_at ? dueLabel(task.due_at) : t("tasks.noDue")}
                </button>
                {duePopoverOpen && (
                  <DuePopover
                    dueAt={task.due_at}
                    use24h={use24h}
                    onPick={(iso) => patchTask(task.id, { due_at: iso })}
                    onClear={() => patchTask(task.id, { clear_due_at: true })}
                    onClose={() => setDuePopoverOpen(false)}
                  />
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto grid gap-6 content-start px-5 pt-1 pb-5">
          {!isNew && !task ? (
            <Skeleton height="8rem" />
          ) : !isNew && task && detail ? (
            <>
              <Section index={sectionIndex()}>
                <TaskSectionHead title={t("tasks.description")} />
                {/* Quiet until edited: the card lifts from the drawer's grey to
                    a writable surface and takes an accent border, the same focus
                    language as the due-date field and quick add. */}
                <div className="group overflow-hidden rounded-2xl bg-bg-secondary border border-transparent focus-within:bg-surface focus-within:border-accent transition-colors">
                  <RichTextEditor
                    key={task.id}
                    content={task.description_html}
                    onChange={(html) => debouncedDescSave(task.id, html)}
                    placeholder={t("tasks.descriptionPlaceholder")}
                    editorClassName="prose prose-sm max-w-none focus:outline-none min-h-[60px] px-3.5 py-3 text-text"
                    toolbar="focus"
                    onEscapeBlockedChange={setDescEscapeBlocked}
                  />
                </div>
              </Section>

              <Section index={sectionIndex()}>
                <ChecklistEditor taskId={task.id} items={detail.checklist} />
              </Section>

              {detail.links.length > 0 && (
                <Section index={sectionIndex()}>
                  <LinkedMails taskId={task.id} links={detail.links} />
                </Section>
              )}

              <Section index={sectionIndex()}>
                <TaskFiles attachments={detail.attachments} api={attachmentsApi} dropActive={dropActive} />
              </Section>
            </>
          ) : null}
        </div>

        {!isNew && task && (
          <div className="shrink-0 flex items-center justify-between gap-3 px-5 py-2.5 border-t border-border-light bg-surface">
            <span
              className="text-[11px] text-text-tertiary truncate"
              title={`${t("tasks.createdAt", { date: formatDateTime(parseISO(task.created_at), use24h) })} · ${t("tasks.updatedAt", { date: formatDateTime(parseISO(task.updated_at), use24h) })}`}
            >
              {t("tasks.createdUpdated", {
                created: formatDistanceToNowStrict(parseISO(task.created_at), { addSuffix: true, locale: dateLocale() }),
                updated: formatDistanceToNowStrict(parseISO(task.updated_at), { addSuffix: true, locale: dateLocale() }),
              })}
            </span>
            <button
              onClick={handleDelete}
              className="shrink-0 px-2.5 py-1.5 rounded-lg text-xs text-text-tertiary hover:text-danger hover:bg-danger/10 transition-colors"
            >
              {t("tasks.deleteTask")}
            </button>
          </div>
        )}
      </motion.aside>
    </>
  );
}

/** Textareas do not grow on their own — re-measure on mount and on every edit. */
function autoGrow(el: HTMLTextAreaElement | null) {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
