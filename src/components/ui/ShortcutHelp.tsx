import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import gsap from "gsap";
import { useTranslation } from "react-i18next";

interface ShortcutHelpProps {
  isOpen: boolean;
  onClose: () => void;
}

const SHORTCUTS: { groupKey: string; items: { keys: string; descKey: string }[] }[] = [
  {
    groupKey: "navigation",
    items: [
      { keys: "j / k", descKey: "nextPrev" },
      { keys: "Enter", descKey: "openMail" },
    ],
  },
  {
    groupKey: "compose",
    items: [
      { keys: "c", descKey: "newMessage" },
    ],
  },
  {
    groupKey: "app",
    items: [
      { keys: "Ctrl+K", descKey: "commandPalette" },
      { keys: "Ctrl+B", descKey: "toggleSidebar" },
      { keys: "?", descKey: "thisHelp" },
    ],
  },
];

export function ShortcutHelp({ isOpen, onClose }: ShortcutHelpProps) {
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      requestAnimationFrame(() => {
        if (overlayRef.current) {
          gsap.fromTo(overlayRef.current, { opacity: 0 }, { opacity: 1, duration: 0.15 });
        }
        if (panelRef.current) {
          gsap.fromTo(
            panelRef.current,
            { opacity: 0, y: -16, scale: 0.97 },
            { opacity: 1, y: 0, scale: 1, duration: 0.2, ease: "power2.out" }
          );
        }
      });
    }
  }, [isOpen]);

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
        className="w-full max-w-md bg-surface rounded-xl shadow-lg border border-border overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="font-heading text-base font-semibold text-text">
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
                {group.items.map((item) => (
                  <div key={item.keys} className="flex items-center justify-between gap-4">
                    <span className="text-sm text-text-secondary">
                      {t(`shortcuts.desc.${item.descKey}`)}
                    </span>
                    <kbd className="shrink-0 text-xs text-text-secondary bg-bg-secondary border border-border rounded px-2 py-0.5 font-mono">
                      {item.keys}
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
