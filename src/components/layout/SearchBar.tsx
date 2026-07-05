import { useRef, useEffect, useState } from "react";
import { Search, X, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { useSearchMails } from "../../hooks/useSync";

export function SearchBar() {
  const { t } = useTranslation();
  const inputRef = useRef<HTMLInputElement>(null);
  const searchOpen = useAppStore((s) => s.searchOpen);
  const storeQuery = useAppStore((s) => s.searchQuery);
  const setSearchQuery = useAppStore((s) => s.setSearchQuery);
  const setSearchOpen = useAppStore((s) => s.setSearchOpen);

  // Local input state — keep the input responsive while debouncing the global store update.
  // This prevents every keystroke from triggering re-renders in MailList and other consumers.
  const [localQuery, setLocalQuery] = useState(storeQuery);
  const [isDebouncing, setIsDebouncing] = useState(false);

  // Full-text search spans all accounts and folders — don't scope to selected account
  const { data: results } = useSearchMails(searchOpen ? storeQuery : "");
  const resultCount = storeQuery.length >= 2 ? results?.length : undefined;

  // Sync local → store with a small debounce; track pending state for the spinner
  useEffect(() => {
    if (!localQuery) { setIsDebouncing(false); return; }
    if (localQuery === storeQuery) { setIsDebouncing(false); return; }
    setIsDebouncing(true);
    const timer = setTimeout(() => {
      setSearchQuery(localQuery);
      setIsDebouncing(false);
    }, 150);
    return () => clearTimeout(timer);
  }, [localQuery, storeQuery, setSearchQuery]);

  // Sync store → local when opened/closed (e.g. Cmd+K clears query externally)
  useEffect(() => {
    if (searchOpen) {
      setLocalQuery(storeQuery);
      inputRef.current?.focus();
    }
  }, [searchOpen, storeQuery]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      setSearchOpen(false);
    }
  }

  if (!searchOpen) return null;

  return (
    <div className="border-b border-border bg-surface">
      <div className="flex items-center gap-2 px-4 py-2">
        <Search className="w-4 h-4 text-text-tertiary shrink-0" />
        <input
          ref={inputRef}
          type="text"
          value={localQuery}
          onChange={(e) => setLocalQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("search.placeholder")}
          className="flex-1 bg-transparent text-sm text-text placeholder-text-secondary"
        />
        {isDebouncing ? (
          <Loader2 className="w-3.5 h-3.5 text-text-tertiary animate-spin shrink-0" />
        ) : resultCount !== undefined ? (
          <span className="text-[10px] font-medium tabular-nums shrink-0 bg-accent/15 text-accent rounded-full px-1.5 py-0.5 leading-none">
            {resultCount}
          </span>
        ) : null}
        <button
          onClick={() => setSearchOpen(false)}
          className="p-1 rounded hover:bg-hover transition-fast focus:ring-2 focus:ring-accent/50"
        >
          <X className="w-4 h-4 text-text-tertiary" />
        </button>
      </div>
    </div>
  );
}
