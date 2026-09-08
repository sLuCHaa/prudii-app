import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { AnimatePresence, motion, useReducedMotionConfig } from "motion/react";
import { CalendarClock, Plus } from "lucide-react";
import type { CreateTaskInput } from "../../types";
import { useCreateTask } from "../../hooks/useTasks";
import { useAppStore } from "../../stores/appStore";
import { parseQuickAdd } from "../../lib/tasks";
import { DueChip } from "./DueChip";
import { SPRING_SNAPPY } from "../motion/tokens";

export interface QuickAddProps {
  className?: string;
  autoFocus?: boolean;
  /** Present only for the popover variant: Escape (and outside click, handled by the caller) closes it instead of just clearing. */
  onClose?: () => void;
  /** Test-only override — production callers rely on useCreateTask (see TaskDrawer for the same pattern). */
  onCreate?: (input: CreateTaskInput) => void;
}

export function QuickAdd({ className = "", autoFocus, onClose, onCreate }: QuickAddProps) {
  const { t, i18n } = useTranslation();
  const [value, setValue] = useState("");
  const [invalid, setInvalid] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Config-aware: unlike the plain useReducedMotion() hook this also honors a
  // <MotionConfig reducedMotion="always"> ancestor, which is how the test makes
  // the exit animation resolve synchronously instead of only skipping it in prod.
  const reduce = useReducedMotionConfig();

  const addToast = useAppStore((s) => s.addToast);
  const setShowTasks = useAppStore((s) => s.setShowTasks);
  const setOpenTaskId = useAppStore((s) => s.setOpenTaskId);
  const quickAddFocusRequested = useAppStore((s) => s.quickAddFocusRequested);
  const consumeQuickAddFocus = useAppStore((s) => s.consumeQuickAddFocus);
  const createTaskMutation = useCreateTask();

  const parsed = useMemo(() => parseQuickAdd(value, new Date(), i18n.language), [value, i18n.language]);
  const previewTask = parsed.dueAt ? { due_at: parsed.dueAt, status: "open" as const } : null;

  // One-shot: focus once per palette request, then consume it immediately so a later
  // ordinary open of this same (possibly remounted) row doesn't refocus it again.
  useEffect(() => {
    if (quickAddFocusRequested) {
      inputRef.current?.focus();
      consumeQuickAddFocus();
    }
  }, [quickAddFocusRequested, consumeQuickAddFocus]);

  function reset() {
    setValue("");
    setInvalid(false);
    // Re-focus after the value clears so a rapid-fire add keeps the cursor in place.
    requestAnimationFrame(() => inputRef.current?.focus());
  }

  function submit() {
    if (!parsed.title) {
      setInvalid(true);
      return;
    }
    const input: CreateTaskInput = parsed.dueAt ? { title: parsed.title, due_at: parsed.dueAt } : { title: parsed.title };

    if (onCreate) {
      onCreate(input);
      reset();
      return;
    }

    createTaskMutation.mutate(input, {
      onSuccess: (created) => {
        addToast("success", t("tasks.created"), undefined, undefined, {
          label: t("tasks.openCreated"),
          onClick: () => { setShowTasks(true); setOpenTaskId(created.id); },
        });
      },
    });
    reset();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      submit();
    } else if (e.key === "Escape") {
      if (onClose) {
        onClose();
      } else {
        reset();
      }
    }
  }

  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg border bg-bg-secondary transition-colors ${invalid ? "border-danger" : "border-border focus-within:border-accent"} ${className}`}>
      <Plus className="w-4 h-4 text-text-tertiary shrink-0" />
      <input
        ref={inputRef}
        type="text"
        autoFocus={autoFocus}
        value={value}
        onChange={(e) => { setValue(e.target.value); setInvalid(false); }}
        onKeyDown={handleKeyDown}
        placeholder={t("tasks.quickAddPlaceholder")}
        aria-invalid={invalid || undefined}
        aria-label={t("tasks.quickAdd")}
        className="flex-1 min-w-0 bg-transparent text-sm text-text placeholder:text-text-tertiary focus:outline-none"
      />
      <AnimatePresence>
        {previewTask && (
          <motion.span
            key="due-preview"
            initial={reduce ? false : { opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={reduce ? undefined : { opacity: 0, scale: 0.9 }}
            transition={SPRING_SNAPPY}
            className="flex items-center gap-1 px-2 py-0.5 rounded-full bg-accent/10 shrink-0"
          >
            <CalendarClock className="w-3 h-3 text-accent" />
            <DueChip task={previewTask} />
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

interface QuickAddPopoverProps {
  anchorRect: DOMRect;
  onClose: () => void;
}

export function QuickAddPopover({ anchorRect, onClose }: QuickAddPopoverProps) {
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  const style = {
    position: "fixed" as const,
    top: anchorRect.bottom + 6,
    right: Math.max(8, window.innerWidth - anchorRect.right),
  };

  return createPortal(
    <div
      ref={rootRef}
      style={style}
      className="z-9999 w-80 max-w-[92vw] bg-surface rounded-lg shadow-lg border border-border p-2 menu-enter"
    >
      <QuickAdd autoFocus onClose={onClose} />
    </div>,
    document.body,
  );
}
