import { useState, useCallback, useEffect, useRef } from "react";
import { Sidebar } from "./Sidebar";
import { MailList } from "./MailList";
import { MailDetail } from "./MailDetail";
import { TitleBar } from "./TitleBar";
import { ResizeHandle } from "./ResizeHandle";
import { AccountWizard } from "../accounts/AccountWizard";
import { SettingsPanel } from "../settings/SettingsPanel";
import { AttachmentBrowser } from "./AttachmentBrowser";
import { OfflineBanner } from "./OfflineBanner";
import { UpdateBanner } from "../ui/UpdateBanner";
import { WelcomeScreen } from "../accounts/WelcomeScreen";
import { useAppStore } from "../../stores/appStore";
import { openComposeWindow } from "../../lib/composeWindow";
import { useAccounts } from "../../hooks/useAccounts";

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 400;
const MAILLIST_MIN = 250;
const MAILLIST_MAX = 600;

export function AppLayout() {
  const showAccountWizard = useAppStore((s) => s.showAccountWizard);
  const showSettings = useAppStore((s) => s.showSettings);
  const composeOpen = useAppStore((s) => s.composeOpen);
  const closeCompose = useAppStore((s) => s.closeCompose);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const showAttachmentBrowser = useAppStore((s) => s.showAttachmentBrowser);
  const [sidebarWidth, setSidebarWidth] = useState(240);
  const [mailListWidth, setMailListWidth] = useState(320);
  const [isResizing, setIsResizing] = useState(false);
  const { data: accounts } = useAccounts();
  // First-run: accounts loaded (not undefined) and empty → show welcome screen.
  const noAccounts = accounts !== undefined && accounts.length === 0;

  // ONLY depends on composeOpen — all other values read imperatively from store.
  useEffect(() => {
    if (!composeOpen) return;
    const s = useAppStore.getState();
    openComposeWindow({
      mode: s.composeMode,
      originalMail: s.composeMail,
      accounts: accounts ?? [],
      appSettings: s.appSettings,
      selectedAccountId: s.selectedAccountId,
      darkMode: s.darkMode,
      mailtoParams: s.composeMailtoParams,
      aiReplyText: s.composeAiReplyText,
      snapshot: s.undoSend.composeSnapshot,
    });
    closeCompose();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composeOpen]);

  // Restore focus to the trigger element after AccountWizard / SettingsPanel close.
  const lastFocusedRef = useRef<HTMLElement | null>(null);
  const modalOpen = showAccountWizard || showSettings;
  useEffect(() => {
    if (modalOpen) {
      if (!lastFocusedRef.current) {
        const active = document.activeElement;
        if (active && active !== document.body && active instanceof HTMLElement) {
          lastFocusedRef.current = active;
        }
      }
    } else if (lastFocusedRef.current) {
      const el = lastFocusedRef.current;
      lastFocusedRef.current = null;
      queueMicrotask(() => {
        try { el.focus(); } catch { /* element may have been removed */ }
      });
    }
  }, [modalOpen]);

  // Disable default browser context menu (allow on inputs for copy/paste)
  useEffect(() => {
    function handleContextMenu(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;
      e.preventDefault();
    }
    document.addEventListener("contextmenu", handleContextMenu);
    return () => document.removeEventListener("contextmenu", handleContextMenu);
  }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "b" && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        toggleSidebar();
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  const handleSidebarResize = useCallback((delta: number) => {
    setSidebarWidth((w) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w + delta)));
  }, []);

  const handleMailListResize = useCallback((delta: number) => {
    setMailListWidth((w) => Math.min(MAILLIST_MAX, Math.max(MAILLIST_MIN, w + delta)));
  }, []);

  return (
    <>
      <div className="app-shell flex flex-col h-screen bg-bg text-text">
        <TitleBar />
        <OfflineBanner />
        <UpdateBanner />
        {noAccounts ? (
          <div className="flex flex-1 min-h-0 bg-bg">
            <WelcomeScreen />
          </div>
        ) : (
          <div className="flex flex-1 min-h-0">
            <div
              style={{ width: sidebarCollapsed ? 52 : sidebarWidth, transition: isResizing ? "none" : "width 200ms ease" }}
              className="shrink-0 overflow-hidden"
            >
              <Sidebar />
            </div>

            {!sidebarCollapsed && (
              <ResizeHandle
                onResize={handleSidebarResize}
                onResizeStart={() => setIsResizing(true)}
                onResizeEnd={() => setIsResizing(false)}
              />
            )}

            {showAttachmentBrowser ? (
              <div className="flex-1 min-w-0 bg-bg">
                <AttachmentBrowser />
              </div>
            ) : (
              <>
                <div style={{ width: mailListWidth }} className="shrink-0 border-r border-border bg-bg">
                  <MailList />
                </div>

                <ResizeHandle onResize={handleMailListResize} />

                <div className="flex-1 min-w-0 bg-bg">
                  <MailDetail />
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {showAccountWizard && <AccountWizard />}
      {showSettings && <SettingsPanel />}
    </>
  );
}
