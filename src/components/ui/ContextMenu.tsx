import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronRight } from "lucide-react";
import { clampToViewport, isFocusable, moveFocus, submenuPosition, typeaheadIndex, type MenuEntry } from "../../lib/menuModel";

export interface ContextMenuProps {
  entries: MenuEntry[];
  x: number;
  y: number;
  onClose: () => void;
  variant?: "menu" | "listbox";
  minWidth?: number;
  ariaLabel?: string;
}

const TYPEAHEAD_MS = 500;

interface SubAnchor {
  left: number;
  top: number;
  right: number;
}

interface PanelProps {
  entries: MenuEntry[];
  position: { left: number; top: number };
  variant: "menu" | "listbox";
  minWidth?: number;
  ariaLabel?: string;
  onCloseAll: () => void;
  onCloseSelf?: () => void; // set for submenus: ArrowLeft/Escape return to the parent item
  measure: (el: HTMLElement) => { left: number; top: number };
}

function MenuPanel({ entries, position, variant, minWidth, ariaLabel, onCloseAll, onCloseSelf, measure }: PanelProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(position);
  const [focused, setFocused] = useState(() => moveFocus(entries, -1, "ArrowDown"));
  const [openSub, setOpenSub] = useState<number | null>(null);
  const [subAnchor, setSubAnchor] = useState<SubAnchor>({ left: 0, top: 0, right: 0 });
  const buffer = useRef({ text: "", at: 0 });

  useLayoutEffect(() => {
    if (ref.current) setPos(measure(ref.current));
  }, [measure, entries.length]);

  useEffect(() => {
    if (openSub !== null) return;
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${focused}"]`);
    el?.focus();
  }, [focused, openSub]);

  const openSubmenu = useCallback((i: number) => {
    const el = ref.current?.querySelector<HTMLElement>(`[data-index="${i}"]`);
    if (!el) return;
    // Real item rect (not a fixed width) so submenuPosition's flip-left branch
    // (anchor.left + 4 - w) lands the flyout back against the true parent edge.
    const r = el.getBoundingClientRect();
    setSubAnchor({ left: r.left, right: r.right, top: r.top });
    setOpenSub(i);
  }, []);

  function activate(i: number) {
    const e = entries[i];
    if (!isFocusable(e)) return;
    if (e.submenu) { openSubmenu(i); return; }
    e.onSelect?.();
    onCloseAll();
  }

  function onKeyDown(ev: React.KeyboardEvent) {
    if (openSub !== null) return; // the open submenu owns the keyboard
    const k = ev.key;
    if (k === "ArrowDown" || k === "ArrowUp" || k === "Home" || k === "End") {
      ev.preventDefault();
      setFocused(moveFocus(entries, focused, k));
    } else if (k === "Enter" || k === " ") {
      ev.preventDefault();
      activate(focused);
    } else if (k === "ArrowRight") {
      const e = entries[focused];
      if (e && isFocusable(e) && e.submenu) { ev.preventDefault(); openSubmenu(focused); }
    } else if (k === "ArrowLeft" && onCloseSelf) {
      ev.preventDefault();
      onCloseSelf();
    } else if (k === "Escape") {
      ev.preventDefault();
      ev.stopPropagation();
      (onCloseSelf ?? onCloseAll)();
    } else if (k.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const now = Date.now();
      buffer.current = { text: now - buffer.current.at < TYPEAHEAD_MS ? buffer.current.text + k : k, at: now };
      const i = typeaheadIndex(entries, focused, buffer.current.text);
      if (i >= 0) { ev.preventDefault(); setFocused(i); }
    }
  }

  const isListbox = variant === "listbox";
  const sub = openSub !== null ? entries[openSub] : null;

  return (
    <>
      <div
        ref={ref}
        role={isListbox ? "listbox" : "menu"}
        aria-label={ariaLabel}
        onKeyDown={onKeyDown}
        className="fixed z-9999 min-w-[180px] max-h-[min(60vh,400px)] overflow-y-auto bg-surface rounded-lg shadow-lg border border-border py-1 menu-enter"
        style={{ left: pos.left, top: pos.top, minWidth }}
      >
        {entries.map((e, i) => {
          if (e.kind === "separator") return <div key={i} className="my-1 border-t border-border" />;
          if (e.kind === "header") {
            return (
              <div key={i} className="px-3 py-1.5 text-xs font-semibold text-text-tertiary flex items-center gap-2">
                {e.icon}{e.label}
              </div>
            );
          }
          const focusable = isFocusable(e);
          return (
            <button
              key={e.id}
              type="button"
              role={isListbox ? "option" : "menuitem"}
              aria-selected={isListbox ? !!e.selected : undefined}
              aria-haspopup={e.submenu ? "menu" : undefined}
              aria-expanded={e.submenu ? openSub === i : undefined}
              aria-disabled={e.disabled || undefined}
              data-index={i}
              tabIndex={i === focused ? 0 : -1}
              disabled={e.disabled}
              onMouseEnter={() => { if (focusable) { setFocused(i); if (e.submenu) openSubmenu(i); else setOpenSub(null); } }}
              onClick={() => activate(i)}
              className={`w-full flex items-center gap-3 px-3 py-1.5 text-sm transition-colors hover:bg-hover focus-visible:bg-hover outline-none ${
                e.danger ? "text-danger" : "text-text"
              } ${e.disabled ? "opacity-50" : ""}`}
            >
              <span className="text-text-tertiary w-4 flex justify-center">{e.icon}</span>
              <span className="flex-1 text-left truncate">{e.label}</span>
              {e.selected && !e.submenu && <Check className="w-3.5 h-3.5 text-accent" />}
              {e.submenu && <ChevronRight className="w-3 h-3 text-text-tertiary" />}
            </button>
          );
        })}
      </div>
      {sub && isFocusable(sub) && sub.submenu && (
        <MenuPanel
          entries={sub.submenu}
          position={{ left: subAnchor.right, top: subAnchor.top }}
          variant={variant}
          onCloseAll={onCloseAll}
          onCloseSelf={() => { setOpenSub(null); }}
          measure={(el) =>
            submenuPosition(
              { left: subAnchor.left, right: subAnchor.right, top: subAnchor.top },
              el.offsetWidth,
              el.offsetHeight,
              window.innerWidth,
              window.innerHeight,
            )
          }
        />
      )}
    </>
  );
}

export function ContextMenu({ entries, x, y, onClose, variant = "menu", minWidth, ariaLabel }: ContextMenuProps) {
  // Captured during render: child effects (which focus the first item) run
  // before this component's effects, so an effect would record the menu itself.
  const previous = useRef<HTMLElement | null>(document.activeElement as HTMLElement | null);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = previous.current;
    return () => { el?.focus?.(); };
  }, []);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [onClose]);

  const measure = useCallback(
    (el: HTMLElement) => clampToViewport(x, y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight),
    [x, y],
  );

  return createPortal(
    <div ref={rootRef}>
      <MenuPanel entries={entries} position={{ left: x, top: y }} variant={variant} minWidth={minWidth} ariaLabel={ariaLabel} onCloseAll={onClose} measure={measure} />
    </div>,
    document.body,
  );
}
