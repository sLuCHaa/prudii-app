import { useEffect, useRef, useState } from "react";
import { Shield, ImageOff, Eye } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";

export function PrivacyBadge() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const trackersBlockedCount = useAppStore((s) => s.trackersBlockedCount);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setSettingsLastTab = useAppStore((s) => s.setSettingsLastTab);

  useEffect(() => {
    if (!open) return;
    function handleClickOutside(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [open]);

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center justify-center w-11 h-full hover:bg-hover transition-colors text-text-secondary"
        title={t("privacy.badge")}
        aria-label={t("privacy.badge")}
      >
        <Shield className="w-4 h-4 pointer-events-none" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 w-72 bg-surface border border-border rounded-lg shadow-lg p-3 z-50 text-xs">
          <h3 className="font-heading text-sm font-semibold text-text mb-2">
            {t("privacy.badge")}
          </h3>
          <ul className="space-y-2">
            <li className="flex items-start gap-2">
              <Shield className="w-3.5 h-3.5 mt-0.5 shrink-0 text-success" />
              <span className="text-text-secondary">{t("privacy.dataLocal.title")}</span>
            </li>
            <li className="flex items-start gap-2">
              <Eye className="w-3.5 h-3.5 mt-0.5 shrink-0 text-text-tertiary" />
              <span className="text-text-secondary">
                {t("privacy.trackersBlocked")}:{" "}
                <span className="text-text font-medium">{trackersBlockedCount}</span>
              </span>
            </li>
            <li className="flex items-start gap-2">
              <ImageOff className="w-3.5 h-3.5 mt-0.5 shrink-0 text-text-tertiary" />
              <span className="text-text-secondary">{t("privacy.imagesBlockedByDefault")}</span>
            </li>
          </ul>
          <button
            type="button"
            onClick={() => {
              setOpen(false);
              setSettingsLastTab("privacy");
              setShowSettings(true);
            }}
            className="mt-3 w-full text-left px-2 py-1.5 rounded hover:bg-hover transition-colors text-accent font-medium"
          >
            {t("privacy.openSettings")}
          </button>
        </div>
      )}
    </div>
  );
}
