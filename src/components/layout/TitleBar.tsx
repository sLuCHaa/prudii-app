import { useEffect, useMemo, useRef, useState } from "react";
import { ClipboardList, Copy, Minus, Square, X } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { useOpenTaskCount } from "../../hooks/useTasks";
import { GearIcon } from "../icons";
import { hideToTray, quitApp } from "../../lib/tauri";
import { isMacOS } from "../../lib/platform";
import { openUrl } from "@tauri-apps/plugin-opener";
import { PrivacyBadge } from "../ui/PrivacyBadge";
import { NumberTween } from "../motion/NumberTween";
import { QuickAddPopover } from "../tasks/QuickAdd";
import { useWindowsCaptionMaxButton, showSystemMenu } from "../../hooks/useWindowsCaption";
import AppLogo from "../../assets/logo.webp";

export function TitleBar() {
  const { t } = useTranslation();
  const appWindow = useMemo(() => getCurrentWindow(), []);
  const setShowSettings = useAppStore((s) => s.setShowSettings);
  const setShowTasks = useAppStore((s) => s.setShowTasks);
  const appSettings = useAppStore((s) => s.appSettings);
  const { data: openTaskCount = 0 } = useOpenTaskCount();
  const tasksButtonRef = useRef<HTMLButtonElement>(null);
  const [quickAddAnchor, setQuickAddAnchor] = useState<DOMRect | null>(null);
  const quickAddFocusRequested = useAppStore((s) => s.quickAddFocusRequested);

  function openQuickAdd() {
    setQuickAddAnchor(tasksButtonRef.current?.getBoundingClientRect() ?? null);
  }

  // The command palette's "quick add" entry only raises the flag; the popover
  // lives here because the title bar is on screen in every view. QuickAdd itself
  // clears the flag once its input takes focus.
  useEffect(() => {
    if (quickAddFocusRequested) openQuickAdd();
  }, [quickAddFocusRequested]);

  // Snap Layouts: the maximize button is reported to the native side and its
  // hover comes back as an event (the button lives in non-client space there).
  const { ref: maxButtonRef, hovered: maxHovered } = useWindowsCaptionMaxButton();

  // The middle caption button must read "restore" while maximized — a stuck
  // maximize glyph is the wrong affordance for Windows users.
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (isMacOS) return;
    let disposed = false;
    const update = () =>
      appWindow.isMaximized().then((m) => { if (!disposed) setMaximized(m); }).catch(() => {});
    update();
    const unlisten = appWindow.onResized(update);
    return () => {
      disposed = true;
      unlisten.then((fn) => fn());
    };
  }, [appWindow]);

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
      onContextMenu={showSystemMenu}
      className="flex items-center justify-between h-8 bg-sidebar border-b border-border shrink-0"
    >
      {/* macOS: left padding clears the native traffic lights (overlay title bar) */}
      <div data-tauri-drag-region className={`flex items-center gap-2 ${isMacOS ? "pl-[88px] pr-3" : "px-3"}`}>
        <button
          onClick={() => openUrl("https://prudii.com")}
          className="flex items-center gap-2 hover:opacity-70 transition-opacity cursor-pointer"
        >
          <img src={AppLogo} alt="Prudii Mail" className="w-4 h-4" />
          <span className="text-xs font-medium text-text-secondary">Prudii Mail</span>
        </button>
      </div>

      <div className="flex h-full">
        <PrivacyBadge />
        <button
          ref={tasksButtonRef}
          onClick={(e) => { if (e.shiftKey) openQuickAdd(); else setShowTasks(true); }}
          onContextMenu={(e) => {
            // Otherwise this bubbles to the title bar's drag-region onContextMenu and opens the OS window menu.
            e.preventDefault();
            e.stopPropagation();
            openQuickAdd();
          }}
          className="relative inline-flex items-center justify-center w-11 h-full hover:bg-hover transition-colors text-text-secondary"
          title={t("tasks.title")}
          aria-label={t("tasks.title")}
        >
          <ClipboardList size={14} strokeWidth={1.5} />
          {openTaskCount > 0 && (
            <span className="absolute top-1.5 right-1.5 min-w-[14px] h-[14px] px-1 rounded-full bg-accent text-white text-[9px] leading-[14px] font-semibold">
              <NumberTween from={0} to={openTaskCount} duration={400} />
            </span>
          )}
        </button>
        {quickAddAnchor && <QuickAddPopover anchorRect={quickAddAnchor} onClose={() => setQuickAddAnchor(null)} />}
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
              ref={maxButtonRef}
              onClick={() => appWindow.toggleMaximize()}
              className={`inline-flex items-center justify-center w-11 h-full transition-colors ${maxHovered ? "bg-hover" : "hover:bg-hover"}`}
              title={maximized ? t("titleBar.restore", { defaultValue: "Restore" }) : t("titleBar.maximize", { defaultValue: "Maximize" })}
              aria-label={maximized ? t("titleBar.restore", { defaultValue: "Restore" }) : t("titleBar.maximize", { defaultValue: "Maximize" })}
            >
              {maximized
                ? <Copy className="w-3.5 h-3.5 text-text-secondary pointer-events-none scale-x-[-1]" />
                : <Square className="w-4 h-4 text-text-secondary pointer-events-none" />}
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
