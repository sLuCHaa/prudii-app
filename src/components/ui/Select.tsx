import { useRef, useState } from "react";
import { ChevronDown } from "lucide-react";
import { ContextMenu } from "./ContextMenu";
import type { MenuEntry } from "../../lib/menuModel";

export interface SelectOption {
  value: string;
  label: string;
  icon?: React.ReactNode;
}

export interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string; // shown when no option matches value
  className?: string; // trigger button classes (defaults to the settings input look)
  ariaLabel?: string;
}

const DEFAULT_TRIGGER = "w-full flex items-center gap-2 px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm text-left focus:border-accent";

export function Select({ value, options, onChange, placeholder, className = DEFAULT_TRIGGER, ariaLabel }: SelectProps) {
  const ref = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState<{ x: number; y: number; w: number } | null>(null);
  const current = options.find((o) => o.value === value);

  function openList() {
    // Focus the trigger first so it (not the last hovered option) reliably
    // gets focus back after a mouse pick on WebKit.
    ref.current?.focus();
    const r = ref.current?.getBoundingClientRect();
    if (r) setOpen({ x: r.left, y: r.bottom + 4, w: r.width });
  }

  const entries: MenuEntry[] = options.map((o) => ({
    kind: "item",
    id: o.value || "__empty",
    label: o.label,
    icon: o.icon,
    selected: o.value === value,
    onSelect: () => onChange(o.value),
  }));

  return (
    <>
      <button
        ref={ref}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={!!open}
        aria-label={ariaLabel}
        onMouseDown={(e) => { if (open) e.preventDefault(); }}
        onClick={() => { if (open) setOpen(null); else openList(); }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === " " || e.key === "Enter") {
            e.preventDefault();
            openList();
          }
        }}
        className={className}
      >
        <span className="flex-1 truncate">{current?.label ?? placeholder ?? ""}</span>
        <ChevronDown className="w-4 h-4 text-text-tertiary shrink-0" />
      </button>
      {open && (
        <ContextMenu
          variant="listbox"
          entries={entries}
          x={open.x}
          y={open.y}
          minWidth={open.w}
          onClose={() => setOpen(null)}
          ariaLabel={ariaLabel}
        />
      )}
    </>
  );
}
