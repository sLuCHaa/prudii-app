import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "motion/react";
import { GripVertical, Plus } from "lucide-react";
import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { DragEndEvent } from "@dnd-kit/core";
import type { ChecklistItem } from "../../types";
import { useChecklist } from "../../hooks/useTasks";
import { SPRING_SNAPPY } from "../motion/tokens";

function Checkmark({ reduce }: { reduce: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="w-2.5 h-2.5 text-white" fill="none">
      <motion.path
        d="M4 12.5L9.5 18L20 6"
        stroke="currentColor"
        strokeWidth={3}
        strokeLinecap="round"
        strokeLinejoin="round"
        initial={{ pathLength: 0 }}
        animate={{ pathLength: 1 }}
        transition={reduce ? { duration: 0 } : { duration: 0.2, ease: "easeOut" }}
      />
    </svg>
  );
}

interface RowProps {
  item: ChecklistItem;
  onToggle: () => void;
  onCommit: (text: string) => void;
  onEnter: () => void;
  onBackspaceEmpty: () => void;
  onDelete: () => void;
  registerInput: (id: string, el: HTMLInputElement | null) => void;
}

function ChecklistRow({ item, onToggle, onCommit, onEnter, onBackspaceEmpty, onDelete, registerInput }: RowProps) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const [text, setText] = useState(item.text);

  useEffect(() => setText(item.text), [item.text]);

  const style = {
    transform: CSS.Transform.toString(transform),
    transition: transition ?? undefined,
    opacity: isDragging ? 0.5 : 1,
  };

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      onCommit(text);
      onEnter();
    } else if (e.key === "Backspace" && text === "" && e.currentTarget.selectionStart === 0) {
      e.preventDefault();
      onBackspaceEmpty();
    }
  }

  return (
    <div ref={setNodeRef} style={style} className="flex items-center gap-2 group py-0.5">
      <button
        type="button"
        {...attributes}
        {...listeners}
        className="shrink-0 text-text-tertiary opacity-0 group-hover:opacity-100 cursor-grab active:cursor-grabbing"
        tabIndex={-1}
      >
        <GripVertical className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={onToggle}
        aria-pressed={item.done}
        className={`shrink-0 w-4 h-4 rounded-full border flex items-center justify-center transition-colors ${
          item.done ? "bg-accent border-accent" : "border-border hover:border-accent"
        }`}
      >
        {item.done && <Checkmark reduce={!!reduce} />}
      </button>
      <input
        ref={(el) => registerInput(item.id, el)}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => { if (text.trim()) onCommit(text); else onDelete(); }}
        onKeyDown={handleKeyDown}
        className={`flex-1 min-w-0 bg-transparent text-sm focus:outline-none ${item.done ? "line-through text-text-tertiary" : "text-text"}`}
      />
      <button
        type="button"
        onClick={onDelete}
        className="shrink-0 text-text-tertiary opacity-0 group-hover:opacity-100 hover:text-danger transition-colors text-xs px-1"
        aria-label={t("common.delete")}
      >
        ×
      </button>
    </div>
  );
}

interface ChecklistEditorProps {
  taskId: string;
  items: ChecklistItem[];
}

export function ChecklistEditor({ taskId, items }: ChecklistEditorProps) {
  const { t } = useTranslation();
  const { addItem, updateItem, deleteItem, reorder } = useChecklist(taskId);
  const [newText, setNewText] = useState("");
  const inputsRef = useRef<Map<string, HTMLInputElement>>(new Map());
  const pendingFocusRef = useRef<string | null>(null);

  useEffect(() => {
    if (!pendingFocusRef.current) return;
    const el = inputsRef.current.get(pendingFocusRef.current);
    if (el) {
      el.focus();
      const end = el.value.length;
      el.setSelectionRange(end, end);
      pendingFocusRef.current = null;
    }
  }, [items]);

  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  const total = items.length;
  const done = items.filter((i) => i.done).length;
  const pct = total > 0 ? (done / total) * 100 : 0;

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    const ids = items.map((i) => i.id);
    const oldIndex = ids.indexOf(String(active.id));
    const newIndex = ids.indexOf(String(over.id));
    if (oldIndex === -1 || newIndex === -1) return;
    reorder.mutate(arrayMove(ids, oldIndex, newIndex));
  }

  function insertAfter(currentId: string) {
    addItem.mutate("", {
      onSuccess: (created) => {
        const ids = items.map((i) => i.id);
        const idx = ids.indexOf(currentId);
        const reordered = [...ids.slice(0, idx + 1), created.id, ...ids.slice(idx + 1)];
        reorder.mutate(reordered);
        pendingFocusRef.current = created.id;
      },
    });
  }

  function removeAndFocusNeighbor(item: ChecklistItem) {
    const ids = items.map((i) => i.id);
    const idx = ids.indexOf(item.id);
    const neighbor = ids[idx - 1] ?? ids[idx + 1] ?? null;
    deleteItem.mutate(item.id);
    pendingFocusRef.current = neighbor;
  }

  function handleAddSubmit() {
    const text = newText.trim();
    if (!text) return;
    addItem.mutate(text);
    setNewText("");
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary">{t("tasks.checklist")}</h3>
        {total > 0 && <span className="text-xs text-text-tertiary tabular-nums">{done}/{total}</span>}
      </div>
      {total > 0 && (
        <div className="h-1 bg-bg-secondary rounded-full overflow-hidden mb-2">
          <motion.div className="h-full bg-accent" animate={{ width: `${pct}%` }} transition={SPRING_SNAPPY} />
        </div>
      )}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={items.map((i) => i.id)} strategy={verticalListSortingStrategy}>
          {items.map((item) => (
            <ChecklistRow
              key={item.id}
              item={item}
              registerInput={(id, el) => { if (el) inputsRef.current.set(id, el); else inputsRef.current.delete(id); }}
              onToggle={() => updateItem.mutate({ id: item.id, done: !item.done })}
              onCommit={(text) => { if (text !== item.text) updateItem.mutate({ id: item.id, text }); }}
              onEnter={() => insertAfter(item.id)}
              onBackspaceEmpty={() => removeAndFocusNeighbor(item)}
              onDelete={() => deleteItem.mutate(item.id)}
            />
          ))}
        </SortableContext>
      </DndContext>
      <div className="flex items-center gap-2 mt-1 pl-6">
        <Plus className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
        <input
          value={newText}
          onChange={(e) => setNewText(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); handleAddSubmit(); } }}
          onBlur={handleAddSubmit}
          placeholder={t("tasks.addChecklistItem")}
          className="flex-1 min-w-0 bg-transparent text-sm text-text placeholder:text-text-tertiary focus:outline-none"
        />
      </div>
    </div>
  );
}
