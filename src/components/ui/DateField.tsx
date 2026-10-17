import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { format, isBefore, startOfDay } from "date-fns";
import { CalendarDays } from "lucide-react";
import { isoDate, parseIsoDate } from "../../lib/calendar/dates";
import { dateLocale } from "../../lib/dateUtils";
import { weekStartsOn } from "../../lib/localeDefaults";
import { MiniMonth } from "./MiniMonth";

const TRIGGER = "flex items-center gap-2 h-9 px-3 rounded-control inset-shadow-field border border-border bg-bg-secondary text-sm text-left outline-none focus:border-accent";
const FOOTER_BUTTON = "px-2 py-1 rounded-md text-xs font-medium text-accent hover:bg-hover transition-colors";

const weekStart = weekStartsOn();

interface DateFieldProps {
  /** `yyyy-MM-dd`, or "" when no date is set. */
  value: string;
  onChange: (value: string) => void;
  min?: string;
  clearable?: boolean;
  ariaLabel?: string;
  className?: string;
}

/** Date input with the app's own month picker; the native one ignores the theme. */
export function DateField({ value, onChange, min, clearable = false, ariaLabel, className = "w-full" }: DateFieldProps) {
  const { t } = useTranslation();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const selected = value ? parseIsoDate(value) : null;
  const minDate = min ? parseIsoDate(min) : undefined;
  const today = startOfDay(new Date());

  const close = useCallback((refocus: boolean) => {
    setAnchor(null);
    if (refocus) triggerRef.current?.focus();
  }, []);

  function open() {
    const r = triggerRef.current?.getBoundingClientRect();
    if (r) setAnchor(r);
  }

  function commit(next: string) {
    if (next !== value) onChange(next);
    close(true);
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={!!anchor}
        aria-label={ariaLabel}
        onClick={() => (anchor ? close(false) : open())}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !anchor) {
            e.preventDefault();
            e.stopPropagation();
            open();
          }
        }}
        className={`${TRIGGER} ${className}`}
      >
        <span className={`min-w-0 flex-1 truncate ${selected ? "text-text" : "text-text-tertiary"}`}>
          {selected ? format(selected, "EEE, PP", { locale: dateLocale() }) : t("picker.chooseDate")}
        </span>
        <CalendarDays className="h-4 w-4 shrink-0 text-text-tertiary" />
      </button>
      {anchor && triggerRef.current &&
        createPortal(
          <PickerPanel anchor={anchor} trigger={triggerRef.current} label={ariaLabel ?? t("picker.chooseDate")} onClose={close}>
            <MiniMonth
              selected={selected}
              weekStart={weekStart}
              min={minDate}
              size="md"
              autoFocus
              onSelect={(day) => commit(isoDate(day))}
            />
            <div className="mt-2 flex items-center justify-between border-t border-border pt-2">
              {clearable ? (
                <button type="button" onClick={() => commit("")} className={FOOTER_BUTTON}>
                  {t("picker.clear")}
                </button>
              ) : <span />}
              <button
                type="button"
                disabled={!!minDate && isBefore(today, minDate)}
                onClick={() => commit(isoDate(today))}
                className={`${FOOTER_BUTTON} disabled:opacity-40`}
              >
                {t("picker.today")}
              </button>
            </div>
          </PickerPanel>,
          document.body,
        )}
    </>
  );
}

interface PickerPanelProps {
  anchor: DOMRect;
  trigger: HTMLElement;
  label: string;
  onClose: (refocus: boolean) => void;
  children: React.ReactNode;
}

function PickerPanel({ anchor, trigger, label, onClose, children }: PickerPanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(8, Math.min(anchor.left, window.innerWidth - w - 8));
    const below = anchor.bottom + 4;
    const top = below + h <= window.innerHeight - 8 ? below : Math.max(8, anchor.top - h - 4);
    setPos({ left, top });
  }, [anchor]);

  useEffect(() => {
    // Window capture runs ahead of the drawers' and dialogs' own Escape/Tab handlers.
    function onKey(e: KeyboardEvent) {
      const inside = ref.current?.contains(document.activeElement) ?? false;
      if (e.key === "Escape" || (e.key === "Tab" && inside)) {
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
      }
    }
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (ref.current?.contains(target) || trigger.contains(target)) return;
      onClose(false);
    }
    function onScroll(e: Event) {
      if (!ref.current?.contains(e.target as Node)) onClose(false);
    }
    const onResize = () => onClose(false);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  }, [onClose, trigger]);

  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      data-floating-panel
      // Like a native picker: keys typed here never reach the window-level shortcuts.
      onKeyDown={(e) => e.stopPropagation()}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-9999 w-68 p-3 rounded-xl bg-surface border border-border shadow-lg inset-shadow-edge menu-enter"
    >
      {children}
    </div>
  );
}
