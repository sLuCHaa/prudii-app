import { useEffect, useId, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Search } from "lucide-react";
import type { Task } from "../../types";
import { useTasks } from "../../hooks/useTasks";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { DueChip } from "./DueChip";

const NO_TASKS: Task[] = [];

export interface TaskPickerDialogProps {
  open: boolean;
  onClose: () => void;
  onPick: (taskId: string) => void;
  /** Tasks already linked to the mail — they stay out of the list. */
  excludeTaskIds?: string[];
  /** Test-only override — production callers rely on useTasks (see TaskDrawer for the same pattern). */
  tasks?: Task[];
}

export function TaskPickerDialog({ open, onClose, onPick, excludeTaskIds, tasks }: TaskPickerDialogProps) {
  const { t } = useTranslation();
  const query = useTasks();
  const [search, setSearch] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const listId = useId();
  const panelRef = useFocusTrap<HTMLDivElement>(open, { initialFocus: false });

  const source = tasks ?? query.data ?? NO_TASKS;
  const excludedKey = (excludeTaskIds ?? []).join(",");
  const items = useMemo(() => {
    const excluded = new Set(excludedKey ? excludedKey.split(",") : []);
    const needle = search.trim().toLowerCase();
    return source
      .filter((task) => task.status !== "done" && !excluded.has(task.id))
      .filter((task) => !needle || task.title.toLowerCase().includes(needle));
  }, [source, excludedKey, search]);

  // A refetch or a longer excludeTaskIds can shrink the list under a stored
  // index, so the highlight is clamped at use instead of only reset on search.
  const current = Math.min(active, Math.max(items.length - 1, 0));

  useEffect(() => {
    setActive(0);
  }, [search]);

  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>("[data-active='true']")?.scrollIntoView({ block: "nearest" });
  }, [active]);

  if (!open) return null;

  function pick(task: Task | undefined) {
    if (!task) return;
    onPick(task.id);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // The mail list keeps a window-level shortcut handler (a/e/Delete, arrows,
    // Enter): as a modal, this dialog swallows every plain key press.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.stopPropagation();
    if (!["ArrowDown", "ArrowUp", "Enter", "Escape"].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "ArrowDown") {
      setActive(items.length === 0 ? 0 : (current + 1) % items.length);
    } else if (e.key === "ArrowUp") {
      setActive(items.length === 0 ? 0 : (current - 1 + items.length) % items.length);
    } else if (e.key === "Enter") {
      pick(items[current]);
    } else {
      onClose();
    }
  }

  return createPortal(
    <div
      className="fixed inset-0 z-100 modal-backdrop flex items-start justify-center pt-[15vh]"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={t("tasks.pickTask")}
        onKeyDown={onKeyDown}
        className="menu-enter w-[440px] max-w-[92vw] overflow-hidden rounded-lg border border-border bg-surface shadow-lg"
      >
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <Search className="w-4 h-4 shrink-0 text-text-tertiary" />
          <input
            autoFocus
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t("tasks.pickTaskSearch")}
            aria-label={t("tasks.pickTaskSearch")}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={items[current] ? `${listId}-${items[current].id}` : undefined}
            className="min-w-0 flex-1 bg-transparent text-sm text-text placeholder:text-text-tertiary focus:outline-none"
          />
        </div>
        <div ref={listRef} id={listId} role="listbox" aria-label={t("tasks.pickTask")} className="max-h-[min(50vh,320px)] overflow-y-auto py-1">
          {items.length === 0 ? (
            <div className="px-3 py-6 text-center text-sm text-text-tertiary">{t("tasks.noOpenTasks")}</div>
          ) : (
            items.map((task, i) => (
              <button
                key={task.id}
                id={`${listId}-${task.id}`}
                type="button"
                role="option"
                aria-selected={i === current}
                data-active={i === current}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(task)}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors ${
                  i === current ? "bg-hover" : ""
                }`}
              >
                <span className="min-w-0 flex-1 truncate text-text">{task.title}</span>
                <DueChip task={task} />
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
