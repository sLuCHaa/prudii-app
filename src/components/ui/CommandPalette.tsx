import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { Search, Inbox, Send, FileText, Archive, Star, Settings, Trash2, Pencil, FolderOpen, Sun, Moon, Palette, LayoutGrid, Languages, HelpCircle } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { SPRING_BOUNCY } from "../motion/tokens";
import { useAppStore } from "../../stores/appStore";
import { useTranslation } from "react-i18next";
import { changeLanguage } from "../../lib/i18n";
import { updateAppSettings } from "../../lib/tauri";
import { getRecentCommands, recordCommandRun } from "../../lib/recentCommands";
import { GradientAvatar } from "../motion/GradientAvatar";
import type { Folder, Account, AccentColor, DensityMode } from "../../types";

const META = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl";

interface CommandItem {
  id: string;
  label: string;
  icon: React.ReactNode;
  section: string;
  action: () => void;
  shortcut?: string;
  /** Email used for GradientAvatar in @ search mode */
  accountEmail?: string;
  /** Display name used for GradientAvatar in @ search mode */
  accountName?: string;
}

export function CommandPalette() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const {
    accounts,
    folders,
    setSelectedFolderId,
    setSelectedAccountId,
    setActiveFilter,
    setShowAllInboxes,
    setActiveCombinedFolder,
    setShowSettings,
    openCompose,
    setSearchOpen,
    themeMode,
    setThemeMode,
    appSettings,
    setAppSettings,
    toggleSidebar,
  } = useAppStore();

  // Expose help-overlay opener via a custom event so App.tsx can respond
  const openHelp = useCallback(() => {
    window.dispatchEvent(new CustomEvent("prudii:open-help"));
    setOpen(false);
  }, []);

  const commands: CommandItem[] = useMemo(() => {
    const items: CommandItem[] = [];

    const groupActions = t("commandPalette.group.actions");
    const groupFolders = t("commandPalette.group.folders");
    const groupAccounts = t("commandPalette.group.accounts");

    items.push({
      id: "compose",
      label: t("compose.newMessage"),
      icon: <Pencil className="w-4 h-4" />,
      section: groupActions,
      action: () => openCompose("new"),
      shortcut: "c",
    });
    items.push({
      id: "search",
      label: t("search.placeholder"),
      icon: <Search className="w-4 h-4" />,
      section: groupActions,
      action: () => setSearchOpen(true),
      shortcut: "/",
    });
    items.push({
      id: "settings",
      label: t("settings.title"),
      icon: <Settings className="w-4 h-4" />,
      section: groupActions,
      action: () => setShowSettings(true),
    });
    items.push({
      id: "starred",
      label: t("sidebar.starred"),
      icon: <Star className="w-4 h-4" />,
      section: groupActions,
      action: () => setActiveFilter("starred"),
    });

    items.push({
      id: "help",
      label: t("commandPalette.help"),
      icon: <HelpCircle className="w-4 h-4" />,
      section: groupActions,
      action: openHelp,
      shortcut: "?",
    });

    items.push({
      id: "sidebar-toggle",
      label: t("shortcuts.desc.toggleSidebar"),
      icon: <LayoutGrid className="w-4 h-4" />,
      section: groupActions,
      action: () => toggleSidebar(),
      shortcut: `${META}+B`,
    });

    const isDark = themeMode === "dark" || (themeMode === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    items.push({
      id: "theme-toggle",
      label: isDark ? t("commandPalette.themeLightLabel") : t("commandPalette.themeDarkLabel"),
      icon: isDark ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />,
      section: groupActions,
      action: () => setThemeMode(isDark ? "light" : "dark"),
    });

    const accentColors: { value: AccentColor; label: string }[] = [
      { value: "blue",   label: t("commandPalette.accentBlue") },
      { value: "purple", label: t("commandPalette.accentPurple") },
      { value: "green",  label: t("commandPalette.accentGreen") },
      { value: "orange", label: t("commandPalette.accentOrange") },
      { value: "pink",   label: t("commandPalette.accentPink") },
      { value: "red",    label: t("commandPalette.accentRed") },
      { value: "teal",   label: t("commandPalette.accentTeal") },
      { value: "amber",  label: t("commandPalette.accentAmber") },
    ];
    for (const accent of accentColors) {
      items.push({
        id: `accent-${accent.value}`,
        label: accent.label,
        icon: <Palette className="w-4 h-4" />,
        section: groupActions,
        action: async () => {
          const next = { ...appSettings, accent_color: accent.value };
          setAppSettings(next);
          document.documentElement.setAttribute("data-accent", accent.value);
          updateAppSettings(next).catch(() => {});
        },
      });
    }

    const densityOptions: { value: DensityMode; label: string }[] = [
      { value: "compact",     label: t("settings.density.compact") },
      { value: "comfortable", label: t("settings.density.comfortable") },
      { value: "spacious",    label: t("settings.density.spacious") },
    ];
    for (const d of densityOptions) {
      items.push({
        id: `density-${d.value}`,
        label: d.label,
        icon: <LayoutGrid className="w-4 h-4" />,
        section: groupActions,
        action: async () => {
          const next = { ...appSettings, density: d.value };
          setAppSettings(next);
          document.documentElement.setAttribute("data-density", d.value);
          updateAppSettings(next).catch(() => {});
        },
      });
    }

    const languages: { value: string; label: string }[] = [
      { value: "de", label: t("settings.language.de") },
      { value: "en", label: t("settings.language.en") },
      { value: "es", label: t("settings.language.es") },
      { value: "fr", label: t("settings.language.fr") },
      { value: "pt", label: t("settings.language.pt") },
      { value: "ru", label: t("settings.language.ru") },
      { value: "zh", label: t("settings.language.zh") },
    ];
    for (const lang of languages) {
      items.push({
        id: `lang-${lang.value}`,
        label: lang.label,
        icon: <Languages className="w-4 h-4" />,
        section: groupActions,
        action: async () => {
          changeLanguage(lang.value as import("../../lib/i18n").AppLanguage);
          const next = { ...appSettings, language: lang.value };
          setAppSettings(next);
          updateAppSettings(next).catch(() => {});
        },
      });
    }

    if (accounts.length > 1) {
      items.push({
        id: "all-inboxes",
        label: t("sidebar.allInboxes"),
        icon: <Inbox className="w-4 h-4" />,
        section: groupFolders,
        action: () => setShowAllInboxes(true),
      });
      for (const type of ["sent", "drafts", "trash", "archive"] as const) {
        const labels: Record<string, string> = {
          sent: t("sidebar.allSent"),
          drafts: t("sidebar.allDrafts"),
          trash: t("sidebar.allTrash"),
          archive: t("sidebar.allArchive"),
        };
        const icons: Record<string, React.ReactNode> = {
          sent: <Send className="w-4 h-4" />,
          drafts: <FileText className="w-4 h-4" />,
          trash: <Trash2 className="w-4 h-4" />,
          archive: <Archive className="w-4 h-4" />,
        };
        items.push({
          id: `combined-${type}`,
          label: labels[type],
          icon: icons[type],
          section: groupFolders,
          action: () => setActiveCombinedFolder(type),
        });
      }
    }

    if (accounts.length > 1) {
      for (const account of accounts) {
        items.push({
          id: `switch-account-${account.id}`,
          label: account.display_name || account.email,
          icon: <GradientAvatar email={account.email} name={account.display_name} size={16} />,
          section: groupAccounts,
          action: () => {
            setSelectedAccountId(account.id);
            setActiveFilter(null);
            useAppStore.setState({ showAllInboxes: false, activeCombinedFolder: null });
          },
          accountEmail: account.email,
          accountName: account.display_name,
        });
      }
    }

    for (const account of accounts) {
      const accountFolders = folders.filter((f) => f.account_id === account.id);
      for (const folder of accountFolders) {
        items.push({
          id: `folder-${folder.id}`,
          label: `${folder.name}`,
          icon: <FolderOpen className="w-4 h-4" />,
          section: accounts.length > 1 ? `${groupAccounts} — ${account.display_name}` : groupFolders,
          action: () => {
            setSelectedAccountId(account.id);
            setSelectedFolderId(folder.id);
            setActiveFilter(null);
            useAppStore.setState({ showAllInboxes: false, activeCombinedFolder: null });
          },
          accountEmail: account.email,
          accountName: account.display_name,
        });
      }
    }

    return items;
  }, [accounts, folders, t, themeMode, appSettings, openHelp, toggleSidebar]);

  const recentIds = useMemo(() => (query === "" ? getRecentCommands() : []), [query]);
  const recentCommands = useMemo(() => {
    const groupRecent = t("commandPalette.group.recent");
    return recentIds
      .map((id) => commands.find((c) => c.id === id))
      .filter((c): c is CommandItem => c !== undefined)
      .map((c) => ({ ...c, section: groupRecent }));
  }, [recentIds, commands, t]);

  const filtered = useMemo(() => {
    // @ prefix: account quick-switch mode
    if (query.startsWith("@")) {
      const groupAccounts = t("commandPalette.group.accounts");
      const q = query.slice(1).toLowerCase();
      return commands
        .filter((cmd) => cmd.section === groupAccounts || cmd.section.startsWith(`${groupAccounts} —`))
        .filter((cmd) =>
          q === "" ||
          cmd.label.toLowerCase().includes(q) ||
          (cmd.accountEmail ?? "").toLowerCase().includes(q)
        );
    }

    if (!query.trim()) {
      const recentIdSet = new Set(recentIds);
      const rest = commands.filter((c) => !recentIdSet.has(c.id));
      return [...recentCommands, ...rest];
    }

    const q = query.toLowerCase();
    return commands.filter(
      (cmd) => cmd.label.toLowerCase().includes(q) || cmd.section.toLowerCase().includes(q)
    );
  }, [commands, query, recentIds, recentCommands, t]);

  useEffect(() => {
    setSelectedIndex(0);
  }, [filtered.length]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [open]);

  const executeCommand = useCallback((index: number) => {
    const cmd = filtered[index];
    if (cmd) {
      recordCommandRun(cmd.id);
      cmd.action();
      setOpen(false);
    }
  }, [filtered]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelectedIndex((i) => Math.min(i + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelectedIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      executeCommand(selectedIndex);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  }

  const sections: { label: string; items: (CommandItem & { globalIndex: number })[] }[] = [];
  let currentSection = "";
  for (let i = 0; i < filtered.length; i++) {
    const item = filtered[i];
    if (item.section !== currentSection) {
      currentSection = item.section;
      sections.push({ label: currentSection, items: [] });
    }
    sections[sections.length - 1].items.push({ ...item, globalIndex: i });
  }

  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 modal-backdrop z-150"
            onClick={() => setOpen(false)}
          />
          <motion.div
            initial={{ opacity: 0, y: -20, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10, scale: 0.96, transition: { duration: 0.15 } }}
            transition={SPRING_BOUNCY}
            className="fixed top-[20vh] left-1/2 -translate-x-1/2 w-full max-w-lg z-151 bg-surface rounded-xl shadow-lg border border-border overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-4 py-3 border-b border-border">
              <Search className="w-4 h-4 text-text-tertiary shrink-0" />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={t("commandPalette.placeholder")}
                className="flex-1 bg-transparent text-sm text-text placeholder:text-text-secondary"
              />
              <kbd className="text-xs text-text-tertiary bg-bg-secondary px-1.5 py-0.5 rounded border border-border">
                Esc
              </kbd>
            </div>

            <div className="max-h-[50vh] overflow-y-auto scrollbar-thin py-1">
              {filtered.length === 0 ? (
                <div className="px-4 py-6 text-center text-sm text-text-tertiary">
                  {t("commandPalette.noResults")}
                </div>
              ) : (
                sections.map((section) => (
                  <div key={section.label}>
                    <div className="px-4 py-1.5 text-xs font-medium text-text-tertiary uppercase tracking-wider">
                      {section.label}
                    </div>
                    {section.items.map((item) => {
                      const isActive = selectedIndex === item.globalIndex;
                      const isAccountSearch = query.startsWith("@");
                      const showAvatar = isAccountSearch && item.accountEmail;
                      return (
                        <button
                          key={item.id}
                          onClick={() => executeCommand(item.globalIndex)}
                          onMouseEnter={() => setSelectedIndex(item.globalIndex)}
                          className={`relative w-full flex items-center gap-3 px-4 py-2 text-sm transition-colors ${
                            isActive
                              ? "bg-accent-soft text-accent"
                              : "text-text hover:bg-hover"
                          }`}
                        >
                          {isActive && (
                            <div className="absolute left-0 top-1 bottom-1 w-1 rounded-r bg-accent" />
                          )}
                          <span className="shrink-0 text-text-tertiary">
                            {showAvatar ? (
                              <GradientAvatar
                                email={item.accountEmail!}
                                name={item.accountName}
                                size={20}
                              />
                            ) : (
                              item.icon
                            )}
                          </span>
                          <span className="truncate flex-1">
                            <HighlightedText text={item.label} query={isAccountSearch ? query.slice(1) : query} />
                          </span>
                          {item.shortcut && (
                            <span className="ml-auto shrink-0 text-[10px] font-mono text-text-tertiary border border-border rounded px-1.5 py-0.5 bg-bg-secondary">
                              {item.shortcut}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                ))
              )}
            </div>

            <div className="flex items-center gap-3 px-4 py-2 border-t border-border text-xs text-text-tertiary">
              <span className="flex items-center gap-1">
                <kbd className="bg-bg-secondary px-1 py-0.5 rounded border border-border">↑↓</kbd>
                {t("commandPalette.navigate")}
              </span>
              <span className="flex items-center gap-1">
                <kbd className="bg-bg-secondary px-1 py-0.5 rounded border border-border">↵</kbd>
                {t("commandPalette.select")}
              </span>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>
  );
}

function HighlightedText({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const lowerText = text.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const out: React.ReactNode[] = [];
  let queryIdx = 0;
  for (let i = 0; i < text.length; i++) {
    if (queryIdx < lowerQuery.length && lowerText[i] === lowerQuery[queryIdx]) {
      out.push(
        <mark
          key={i}
          className="bg-warning/30 text-warning font-semibold rounded px-0.5"
          style={{ background: "rgba(245, 158, 11, 0.3)" }}
        >
          {text[i]}
        </mark>,
      );
      queryIdx++;
    } else {
      out.push(text[i]);
    }
  }
  return <>{out}</>;
}
