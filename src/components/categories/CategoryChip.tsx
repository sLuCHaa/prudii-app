import { useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { CATEGORY_COLORS, shownCategory } from "../../lib/categories";
import { CategoryPopover } from "./CategoryPopover";
import type { Mail } from "../../types";

export function CategoryChip({ mail }: { mail: Mail }) {
  const { t } = useTranslation();
  const enabled = useAppStore((s) => s.appSettings.sorting_enabled);
  const hidden = useAppStore((s) => s.appSettings.hidden_categories);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const id = enabled ? shownCategory(mail.category, hidden) : null;
  if (!id) return null;
  const color = CATEGORY_COLORS[id];

  const open = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    setAnchor(e.currentTarget.getBoundingClientRect());
  };

  return (
    <>
      <button
        type="button"
        onClick={open}
        onDoubleClick={(e) => e.stopPropagation()}
        className="shrink-0 rounded-full px-1.5 text-[10.5px] leading-4 font-medium"
        style={{
          background: `color-mix(in srgb, ${color} 16%, transparent)`,
          color: `color-mix(in srgb, ${color} 65%, var(--c-text))`,
        }}
      >
        {t(`categories.names.${id}`)}
      </button>
      {anchor && <CategoryPopover mailId={mail.id} anchor={anchor} onClose={() => setAnchor(null)} />}
    </>
  );
}
