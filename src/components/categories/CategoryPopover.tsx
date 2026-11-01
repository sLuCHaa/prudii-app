import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { useMailCategoryInfo, useSetMailCategory } from "../../hooks/useCategories";
import { CATEGORY_COLORS, CATEGORY_TEXT_MIX, isCategoryId, reasonText, visibleCategories } from "../../lib/categories";

const MARGIN = 8;

export function CategoryPopover({ mailId, anchor, onClose }: { mailId: string; anchor: DOMRect; onClose: () => void }) {
  const { t } = useTranslation();
  const hidden = useAppStore((s) => s.appSettings.hidden_categories);
  const { data: info } = useMailCategoryInfo(mailId);
  const setMailCategory = useSetMailCategory();
  const [rememberSender, setRememberSender] = useState(true);
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ left: anchor.left, top: anchor.bottom + 4 });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const left = Math.max(MARGIN, Math.min(anchor.left, window.innerWidth - w - MARGIN));
    let top = anchor.bottom + 4;
    if (top + h > window.innerHeight - MARGIN) top = Math.max(MARGIN, anchor.top - h - 4);
    setPos((p) => (p.left === left && p.top === top ? p : { left, top }));
  }, [anchor, info]);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const current = info && isCategoryId(info.category) ? info.category : null;
  const choose = (category: string | null) => {
    setMailCategory.mutate({ mailId, category, rememberSender });
    onClose();
  };

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={t("categories.change")}
      tabIndex={-1}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key !== "Escape") e.stopPropagation();
      }}
      onContextMenu={(e) => e.stopPropagation()}
      className="fixed z-[1000] w-72 outline-none rounded-lg border border-border bg-surface p-3 shadow-lg text-sm text-text"
      style={{ left: pos.left, top: pos.top }}
    >
      <div className="font-medium">
        {current ? t("categories.why", { category: t(`categories.names.${current}`) }) : t("categories.whyNone")}
      </div>
      {info && info.reasons.length > 0 && (
        <ul className="mt-1.5 space-y-0.5 text-xs text-text-secondary list-disc pl-4">
          {info.reasons.slice(0, 3).map((r, i) => (
            <li key={i}>{reasonText(t, r)}</li>
          ))}
        </ul>
      )}
      <div className="mt-3 text-xs font-medium text-text-secondary">{t("categories.change")}</div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        {visibleCategories(hidden).map((id) => {
          const color = CATEGORY_COLORS[id];
          return (
            <button
              key={id}
              type="button"
              onClick={() => choose(id)}
              aria-pressed={id === current}
              className="rounded-full px-2 py-0.5 text-[11px]"
              style={{
                background: `color-mix(in srgb, ${color} ${id === current ? 30 : 12}%, transparent)`,
                color: `color-mix(in srgb, ${color} ${CATEGORY_TEXT_MIX[id]}%, var(--c-text))`,
                outline: id === current ? `1.5px solid ${color}` : undefined,
              }}
            >
              {t(`categories.names.${id}`)}
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => choose(null)}
          className="rounded-full px-2 py-0.5 text-[11px] bg-hover text-text-secondary"
        >
          {t("categories.none")}
        </button>
      </div>
      {info?.sender && (
        <label className="mt-3 flex items-center gap-2 text-xs text-text-secondary">
          <input type="checkbox" checked={rememberSender} onChange={(e) => setRememberSender(e.target.checked)} />
          <span className="min-w-0 break-words">{t("categories.rememberSender", { sender: info.sender })}</span>
        </label>
      )}
    </div>,
    document.body,
  );
}
