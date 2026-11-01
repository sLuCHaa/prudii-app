import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { useCategoryCounts } from "../../hooks/useCategories";
import { CATEGORY_COLORS, visibleCategories } from "../../lib/categories";

export function CategorySidebarEntries({ inboxFolderId }: { inboxFolderId: string | null }) {
  const { t } = useTranslation();
  const sortingEnabled = useAppStore((s) => s.appSettings.sorting_enabled);
  const hidden = useAppStore((s) => s.appSettings.hidden_categories);
  const activeCategory = useAppStore((s) => s.activeCategory);
  const showAllInboxes = useAppStore((s) => s.showAllInboxes);
  const selectedFolderId = useAppStore((s) => s.selectedFolderId);
  const openCategory = useAppStore((s) => s.openCategory);
  const setActiveCategory = useAppStore((s) => s.setActiveCategory);
  const { data: counts } = useCategoryCounts(sortingEnabled);

  const unreadByCategory = useMemo(() => {
    const map = new Map<string, number>();
    for (const c of counts ?? []) {
      if (inboxFolderId !== null && c.folder_id !== inboxFolderId) continue;
      map.set(c.category, (map.get(c.category) ?? 0) + c.unread);
    }
    return map;
  }, [counts, inboxFolderId]);

  if (!sortingEnabled) return null;

  const scopeActive = inboxFolderId === null ? showAllInboxes : selectedFolderId === inboxFolderId;

  return (
    <div className="space-y-0.5">
      {visibleCategories(hidden).map((id) => {
        const active = activeCategory === id && scopeActive;
        const unread = unreadByCategory.get(id) ?? 0;
        return (
          <button
            key={id}
            onClick={() => (active ? setActiveCategory(null) : openCategory(id, inboxFolderId))}
            className={`flex items-center gap-2.5 w-full pl-9 pr-3 py-1 rounded-md text-sm transition-colors ${
              active ? "folder-active" : "text-text-secondary hover:bg-hover hover:text-text"
            }`}
          >
            <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: CATEGORY_COLORS[id] }} />
            <span className="flex-1 truncate text-left">{t(`categories.names.${id}`)}</span>
            {unread > 0 && <span className="text-xs font-bold text-accent tabular-nums">{unread}</span>}
          </button>
        );
      })}
    </div>
  );
}
