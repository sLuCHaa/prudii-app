import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { isMacOS } from "../../lib/platform";
import { formatShortcut } from "../../lib/shortcuts";

interface ShortcutHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUTS: { groupKey: string; items: { keys: string; descKey: string; hideOnMac?: boolean }[] }[] = [
  {
    groupKey: "navigation",
    items: [
      { keys: "j / k", descKey: "nextPrev" },
      { keys: "Enter", descKey: "openMail" },
      { keys: "/", descKey: "search" },
      { keys: "Mod+F", descKey: "search" },
    ],
  },
  {
    groupKey: "mail",
    items: [
      { keys: "Mod+R", descKey: "reply" },
      { keys: "Mod+Shift+R", descKey: "replyAll" },
      { keys: "Mod+Shift+F", descKey: "forward" },
      { keys: isMacOS ? "⇧↑ / ⇧↓" : "Shift ↑ / Shift ↓", descKey: "extendSelection" },
      { keys: "Home / End", descKey: "firstLast" },
      { keys: "PgUp / PgDn", descKey: "pageUpDown" },
      { keys: "Space", descKey: "toggleSelect" },
      { keys: "a / e", descKey: "archive" },
      { keys: "Del", descKey: "trashSelected" },
      { keys: "Mod+A", descKey: "selectAll" },
      { keys: "Esc", descKey: "clearSelection" },
    ],
  },
  {
    groupKey: "compose",
    items: [
      { keys: "c", descKey: "newMessage" },
      { keys: "Mod+N", descKey: "newMessage" },
      { keys: "Mod+Enter", descKey: "send" },
      { keys: "Mod+W", descKey: "closeCompose" },
    ],
  },
  {
    groupKey: "app",
    items: [
      { keys: "Mod+K", descKey: "commandPalette" },
      { keys: "Mod+B", descKey: "toggleSidebar" },
      { keys: "Mod+,", descKey: "settings" },
      { keys: "Mod+Shift+N", descKey: "syncAll" },
      { keys: "Mod+Shift+A", descKey: "addAccount" },
      { keys: "Mod+Shift+T", descKey: "openTasks" },
      { keys: "F11", descKey: "fullscreen", hideOnMac: true },
      { keys: "?", descKey: "thisHelp" },
    ],
  },
  {
    groupKey: "tasks",
    items: [
      { keys: "t", descKey: "newTask" },
    ],
  },
];

export function ShortcutHelp({ isOpen, onClose }: ShortcutHelpProps) {
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useFocusTrap<HTMLDivElement>(isOpen);

  useEffect(() => {
    if (!isOpen) return;
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 modal-backdrop z-100 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcut-help-title"
        className="w-full max-w-md bg-surface rounded-xl shadow-lg border border-border overflow-hidden modal-panel-enter"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 id="shortcut-help-title" className="font-heading text-base font-semibold text-text">
            {t("shortcuts.title")}
          </h2>
          <button
            onClick={onClose}
            className="text-text-tertiary hover:text-text transition-colors rounded-md p-1 hover:bg-hover"
            aria-label={t("common.close")}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-5">
          {SHORTCUTS.map((group) => (
            <section key={group.groupKey}>
              <h3 className="text-xs font-medium text-text-tertiary uppercase tracking-wider mb-2">
                {t(`shortcuts.${group.groupKey}`)}
              </h3>
              <div className="space-y-1.5">
                {group.items
                  .filter((item) => !(item.hideOnMac && isMacOS))
                  .map((item) => (
                    <div key={item.keys} className="flex items-center justify-between gap-4">
                      <span className="text-sm text-text-secondary">
                        {t(`shortcuts.desc.${item.descKey}`)}
                      </span>
                      <kbd className="shrink-0 text-xs text-text-secondary bg-bg-secondary border border-border rounded px-2 py-0.5 font-mono">
                        {formatShortcut(item.keys, isMacOS)}
                      </kbd>
                    </div>
                  ))}
              </div>
            </section>
          ))}
        </div>

        <div className="px-5 py-3 border-t border-border">
          <p className="text-xs text-text-tertiary">
            {t("shortcuts.inputHint")}
          </p>
        </div>
      </div>
    </div>
  );
}
