import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Clock } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { dateLocale, formatTime } from "../../lib/dateUtils";
import { parseTimeInput, timeOptions } from "../../lib/timeInput";
import type { MenuEntry } from "../../lib/menuModel";
import { ContextMenu } from "./ContextMenu";

const FIELD = "flex items-center gap-1 h-9 pl-3 pr-1.5 rounded-lg border border-border bg-bg-secondary text-sm text-text focus-within:border-accent";

function label(value: string, use24h: boolean): string {
  const [h, m] = value.split(":").map(Number);
  return formatTime(new Date(2000, 0, 1, h || 0, m || 0), use24h);
}

function dayPeriods() {
  const locale = dateLocale();
  return { am: format(new Date(2000, 0, 1, 1), "a", { locale }), pm: format(new Date(2000, 0, 1, 13), "a", { locale }) };
}

interface TimeFieldProps {
  /** `HH:mm`, 24-hour. */
  value: string;
  onChange: (value: string) => void;
  ariaLabel?: string;
  className?: string;
}

/** Typeable time with a quarter-hour list; the native picker ignores the theme. */
export function TimeField({ value, onChange, ariaLabel, className = "w-30" }: TimeFieldProps) {
  const { t } = useTranslation();
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const fieldRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; w: number } | null>(null);

  function commit() {
    if (draft === null) return;
    const parsed = parseTimeInput(draft, dayPeriods());
    setDraft(null);
    if (parsed && parsed !== value) onChange(parsed);
  }

  function openList() {
    commit();
    inputRef.current?.focus();
    const r = fieldRef.current?.getBoundingClientRect();
    if (r) setMenu({ x: r.left, y: r.bottom + 4, w: r.width });
  }

  const entries: MenuEntry[] = timeOptions(value).map((v) => ({
    kind: "item",
    id: v,
    label: label(v, use24h),
    selected: v === value,
    onSelect: () => onChange(v),
  }));

  return (
    <div ref={fieldRef} className={`${FIELD} ${className}`}>
      <input
        ref={inputRef}
        role="combobox"
        aria-expanded={!!menu}
        aria-controls={menu ? listId : undefined}
        aria-label={ariaLabel}
        value={draft ?? label(value, use24h)}
        onFocus={(e) => e.target.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" && draft !== null) {
            e.preventDefault();
            commit();
          } else if (e.key === "Escape" && draft !== null) {
            e.preventDefault();
            e.stopPropagation();
            setDraft(null);
          } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            openList();
          }
        }}
        className="min-w-0 flex-1 bg-transparent outline-none tabular-nums"
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label={t("picker.chooseTime")}
        // Keeps the open list from closing on this mousedown, so the click below toggles it.
        onMouseDown={(e) => {
          e.preventDefault();
          if (menu) e.stopPropagation();
        }}
        onClick={() => (menu ? setMenu(null) : openList())}
        className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-text-tertiary hover:bg-hover"
      >
        <Clock className="h-4 w-4" />
      </button>
      {menu && (
        <ContextMenu
          variant="listbox"
          entries={entries}
          x={menu.x}
          y={menu.y}
          minWidth={menu.w}
          onClose={() => setMenu(null)}
          ariaLabel={ariaLabel ?? t("picker.chooseTime")}
          id={listId}
        />
      )}
    </div>
  );
}
