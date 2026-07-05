import { useMemo } from "react";
import { Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { GearIcon } from "../icons";
import { hideToTray, quitApp } from "../../lib/tauri";
import { isMacOS } from "../../lib/platform";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PrivacyBadge } from "../ui/PrivacyBadge";
import AppLogo from "../../assets/logo.webp";

export function TitleBar() {
  const { t } = useTranslation();
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const appSettings = useAppStore((s) => s.appSettings);

  const handleClose = () => {
    // Defer to next event loop tick so the native mouse tracking loop
    // (from data-tauri-drag-region) releases the main thread first.
    // Without this, IPC calls that dispatch to the main thread deadlock on macOS.
    setTimeout(async () => {
      try {
        if (appSettings.show_in_tray) {
          await hideToTray();
        } else {
          await quitApp();
        }
      } catch {
        await quitApp().catch(() => {});
      }
    }, 0);
  };

  return (
    <div
      data-tauri-drag-region
      className="flex items-center justify-between h-8 bg-sidebar border-b border-border no-select shrink-0"
    >
      {/* macOS: left padding clears the native traffic lights (overlay title bar) */}
      <div data-tauri-drag-region className={`flex items-center gap-2 ${isMacOS ? "pl-[88px] pr-3" : "px-3"}`}>
        <button
          onClick={() => openUrl("https://prudii.com")}
          className="flex items-center gap-2 hover:opacity-70 transition-opacity cursor-pointer"
        >
          <img src={AppLogo} alt="Prudii Mail" className="w-4 h-4" />
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs font-medium text-text-secondary">Prudii Mail</span>
            <span className="text-[9px] text-text-tertiary italic">Mando'a for shadow</span>
          </div>
        </button>
      </div>

      <div className="flex h-full">
        <PrivacyBadge />
        <button
          onClick={() => setShowSettings(true)}
          className="inline-flex items-center justify-center w-11 h-full hover:bg-hover transition-colors text-text-secondary"
          title={t("titleBar.settings")}
          aria-label={t("titleBar.settings")}
        >
          <GearIcon size={14} strokeWidth={1.5} />
        </button>
        {/* macOS uses the native traffic lights instead (overlay title bar) */}
        {!isMacOS && (
          <>
            <button
              onClick={() => appWindow.minimize()}
              className="inline-flex items-center justify-center w-11 h-full hover:bg-hover transition-colors"
              title={t("titleBar.minimize", { defaultValue: "Minimize" })}
              aria-label={t("titleBar.minimize", { defaultValue: "Minimize" })}
            >
              <Minus className="w-4 h-4 text-text-secondary pointer-events-none" />
            </button>
            <button
              onClick={() => appWindow.toggleMaximize()}
              className="inline-flex items-center justify-center w-11 h-full hover:bg-hover transition-colors"
              title={t("titleBar.maximize", { defaultValue: "Maximize" })}
              aria-label={t("titleBar.maximize", { defaultValue: "Maximize" })}
            >
              <Square className="w-4 h-4 text-text-secondary pointer-events-none" />
            </button>
            <button
              onClick={handleClose}
              className="inline-flex items-center justify-center w-11 h-full hover:bg-danger/90 hover:text-white transition-colors"
              title={t("titleBar.close", { defaultValue: "Close" })}
              aria-label={t("titleBar.close", { defaultValue: "Close" })}
            >
              <X className="w-4 h-4 text-text-secondary pointer-events-none" />
            </button>
          </>
        )}
      </div>
    </div>
  );
}
