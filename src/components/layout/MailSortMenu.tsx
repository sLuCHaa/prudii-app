import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MAIL_SORT_FIELDS, nextSort, sortDirection, sortField, type MailSort, type MailSortField } from "../../lib/mailSort";

export function MailSortMenu({ sort, onChange }: { sort: MailSort; onChange: (sort: MailSort) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const field = sortField(sort);
  const direction = sortDirection(sort);
  const Arrow = direction === "asc" ? ArrowUp : ArrowDown;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  // WebKit does not focus a clicked button, so keys would never reach the menu
  useEffect(() => {
    if (open) itemRefs.current[active]?.focus();
  }, [open, active]);

  const close = () => {
    setOpen(false);
    toggleRef.current?.focus();
  };

  const choose = (f: MailSortField) => {
    onChange(nextSort(sort, f));
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      e.stopPropagation();
      const step = e.key === "ArrowDown" ? 1 : MAIL_SORT_FIELDS.length - 1;
      setActive((i) => (i + step) % MAIL_SORT_FIELDS.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      choose(MAIL_SORT_FIELDS[active]);
    }
  };

  const label = `${t("mailList.sort.button")}: ${t(`mailList.sort.${field}`)}, ${t(`mailList.sort.${direction === "asc" ? "ascending" : "descending"}`)}`;

  return (
    <div ref={rootRef} className="relative" onKeyDown={onKeyDown}>
      <button
        ref={toggleRef}
        onClick={() => {
          setActive(MAIL_SORT_FIELDS.indexOf(field));
          setOpen((o) => !o);
        }}
        className="flex items-center gap-1 px-1.5 py-1 rounded-lg hover:bg-hover transition-colors text-xs text-text-tertiary"
        title={label}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Arrow className="w-3.5 h-3.5" />
        <span>{t(`mailList.sort.${field}`)}</span>
      </button>
      {open && (
        <div role="menu" className="absolute right-0 top-full mt-1 min-w-45 bg-surface rounded-lg shadow-lg border border-border py-1 z-50">
          {MAIL_SORT_FIELDS.map((f, i) => (
            <button
              key={f}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              role="menuitemradio"
              aria-checked={f === field}
              tabIndex={i === active ? 0 : -1}
              onClick={() => choose(f)}
              onMouseEnter={() => setActive(i)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm text-text outline-none transition-colors ${i === active ? "bg-hover" : ""}`}
            >
              <Check className={`w-3.5 h-3.5 ${f === field ? "text-accent" : "invisible"}`} />
              <span className="flex-1 text-left">{t(`mailList.sort.${f}`)}</span>
              {f === field && <Arrow className="w-3.5 h-3.5 text-text-tertiary" />}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
