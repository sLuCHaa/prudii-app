import { useState, useEffect, useRef } from "react";
import { X, Minus, Square, Copy, Pencil, Reply, ReplyAll, Forward } from "lucide-react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { DialogProvider } from "../ui/DialogProvider";
import { ToastContainer } from "../ui/Toast";
import { deleteComposeAutosave } from "../../lib/tauri";
import { ComposeForm } from "./ComposeModal";
import type { ComposeInitData, ComposeMode, ComposeFormHandle } from "./ComposeModal";
import { isMacOS } from "../../lib/platform";
import { useWindowsCaptionMaxButton, showSystemMenu } from "../../hooks/useWindowsCaption";

// Standalone QueryClient for the compose window (needed because ComposeForm
// internally calls useAccounts() which requires a QueryClientProvider context).
const composeQueryClient = new QueryClient();

export function ComposeWindow() {
  const { t } = useTranslation();
  const [initData, setInitData] = useState<ComposeInitData | null>(null);
  const [ready, setReady] = useState(false);
  const [shown, setShown] = useState(false);

  useEffect(() => {
    if (!initData) return;
    const { appSettings, darkMode } = initData;
    document.documentElement.classList.toggle("dark", darkMode);
    document.documentElement.setAttribute("data-accent", appSettings.accent_color);
    document.documentElement.setAttribute("data-density", appSettings.density);
    // Window was created hidden — show it now that content + theme are ready.
    // The window's native background color (set at creation in composeWindow.ts)
    // prevents a white flash before the web content paints. The content itself
    // fades in over a few frames so the window materializes instead of popping.
    const win = getCurrentWindow();
    const reveal = () => requestAnimationFrame(() => setShown(true));
    win
      .show()
      .then(() => {
        // Revealing the content must never wait on focus calls — a rejected
        // or hanging window API otherwise leaves the webview at opacity-0
        // (a white empty window, as happened on macOS).
        reveal();
        if (isMacOS) {
          win.setFocus().catch(() => {});
          return;
        }
        // Windows refuses to raise a window whose show() happened outside the
        // user's click context (the compose-init handshake defers it) — the
        // window then opens BEHIND whatever was focused meanwhile. The brief
        // always-on-top pulse forces the raise; strictly best-effort.
        (async () => {
          try {
            await win.setAlwaysOnTop(true);
            await win.setFocus();
          } catch {
            /* raising is cosmetic — never block anything on it */
          } finally {
            win.setAlwaysOnTop(false).catch(() => {});
          }
        })();
      })
      .catch(reveal);
  }, [initData]);

  // The webview's default right-click menu (Reload, browser items) breaks the
  // native feel. Keep it only where typing happens — there it carries the OS
  // spelling suggestions and clipboard actions.
  useEffect(() => {
    const onContextMenu = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
    };
    window.addEventListener("contextmenu", onContextMenu);
    return () => window.removeEventListener("contextmenu", onContextMenu);
  }, []);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    // Scoped to this window's label — a global listen() receives every
    // compose window's init event.
    win
      .listen<ComposeInitData>("compose-init", (event) => {
        setInitData(event.payload);
        setReady(true);
      })
      .then((fn) => {
        if (cancelled) {
          fn();
          return;
        }
        unlisten = fn;
        // Signal readiness only once the listener is actually registered,
        // otherwise the main window can emit compose-init into the void.
        emit("compose-ready", win.label);
      });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const composeFormRef = useRef<ComposeFormHandle>(null);
  const closeUnlistenRef = useRef<(() => void) | null>(null);
  // Set once the close is confirmed, so the (asynchronously-unregistered)
  // close-requested interceptor below doesn't re-open the discard dialog when
  // getCurrentWindow().close() fires another close-requested event.
  const closingRef = useRef(false);

  const [maximized, setMaximized] = useState(false);
  const sizeSaveTimer = useRef<number | null>(null);
  // Snap Layouts flyout + native hover for the maximize button (Windows).
  const { ref: maxButtonRef, hovered: maxHovered } = useWindowsCaptionMaxButton();

  // Track native maximize state and persist the free-form size.
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onResized(async () => {
      try {
        const isMax = await win.isMaximized();
        setMaximized(isMax);
        if (isMax) return;
        // Debounced: persist the free-form size so the next compose window
        // opens the way the user left this one (see composeWindow.ts).
        if (sizeSaveTimer.current !== null) clearTimeout(sizeSaveTimer.current);
        sizeSaveTimer.current = window.setTimeout(async () => {
          try {
            const scale = (await currentMonitor())?.scaleFactor ?? 1;
            const size = await win.outerSize();
            localStorage.setItem(
              "compose-window-size",
              JSON.stringify({
                w: Math.round(size.width / scale),
                h: Math.round(size.height / scale),
              })
            );
          } catch { /* ignore */ }
        }, 400);
      } catch { /* ignore */ }
    });
    return () => {
      unlisten.then((fn) => fn());
      if (sizeSaveTimer.current !== null) clearTimeout(sizeSaveTimer.current);
    };
  }, []);

  async function handleToggleMaximize() {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch { /* ignore */ }
  }

  // Intercept system close (Alt+F4, taskbar close) to trigger draft dialog
  useEffect(() => {
    const win = getCurrentWindow();
    const unlistenPromise = win.onCloseRequested((event) => {
      // Close already confirmed (discard/save draft) — let it through.
      if (closingRef.current) return;
      if (composeFormRef.current) {
        event.preventDefault();
        composeFormRef.current.requestClose();
      }
    });
    unlistenPromise.then((fn) => { closeUnlistenRef.current = fn; });
    return () => { unlistenPromise.then((fn) => fn()); };
  }, []);

  /** Called by ComposeForm when close is confirmed (after draft dialog or if empty) */
  function handleClose() {
    // Mark as confirmed first (synchronous) so the close-requested interceptor
    // — whose unlisten is async — can't re-trigger the discard dialog.
    closingRef.current = true;
    if (closeUnlistenRef.current) {
      closeUnlistenRef.current();
      closeUnlistenRef.current = null;
    }
    // Every clean exit (send, save draft, discard) funnels through here — the
    // crash-safety autosave must not survive it, or it would be offered for
    // restore at next launch. Fired before destroy; the command outlives the
    // webview because it runs in the Rust process.
    deleteComposeAutosave(getCurrentWindow().label).catch(() => {});
    // destroy() closes immediately WITHOUT firing close-requested again,
    // so the discard dialog can never re-open.
    getCurrentWindow().destroy();
  }

  /** Called by the title bar X button — triggers draft check first */
  function handleCloseRequest() {
    if (composeFormRef.current) {
      composeFormRef.current.requestClose();
    } else {
      closingRef.current = true;
      if (closeUnlistenRef.current) {
        closeUnlistenRef.current();
        closeUnlistenRef.current = null;
      }
      getCurrentWindow().destroy();
    }
  }

  const mode: ComposeMode = initData?.mode ?? "new";
  const modeTitle = mode === "new" ? t("compose.newMessage") : mode === "draft" ? t("compose.draft") : mode === "reply" ? t("compose.reply") : mode === "replyAll" ? t("compose.replyAll") : t("compose.forward");
  const ModeIcon = mode === "reply" ? Reply : mode === "replyAll" ? ReplyAll : mode === "forward" ? Forward : Pencil;

  return (
    <QueryClientProvider client={composeQueryClient}>
    <DialogProvider>
      <div className={`flex flex-col h-screen bg-surface text-text transition-opacity duration-150 ${shown ? "opacity-100" : "opacity-0"}`}>
          {/* macOS: left padding clears the native traffic lights (overlay title bar).
              Windows/Linux: full-height caption buttons like the main window —
              the rounded mini-buttons (and the missing minimize) read as a web
              page, not a window. */}
          <div
            data-tauri-drag-region
            onContextMenu={showSystemMenu}
            className={`flex items-center justify-between h-9 border-b border-border bg-bg-secondary select-none shrink-0 ${isMacOS ? "pl-[88px] pr-4" : "pl-4"}`}
          >
            <h2 data-tauri-drag-region className="flex items-center gap-2 text-sm font-semibold text-text">
              <ModeIcon className="w-4 h-4 text-accent shrink-0" />
              {modeTitle}
            </h2>
            {/* macOS uses the native traffic lights instead (overlay title bar) */}
            {!isMacOS && (
              <div className="flex h-full items-stretch">
                <button
                  onClick={() => getCurrentWindow().minimize()}
                  className="inline-flex items-center justify-center w-11 h-full hover:bg-hover transition-colors"
                  title={t("titleBar.minimize", { defaultValue: "Minimize" })}
                  aria-label={t("titleBar.minimize", { defaultValue: "Minimize" })}
                >
                  <Minus className="w-4 h-4 text-text-secondary pointer-events-none" />
                </button>
                <button
                  ref={maxButtonRef}
                  onClick={handleToggleMaximize}
                  className={`inline-flex items-center justify-center w-11 h-full transition-colors ${maxHovered ? "bg-hover" : "hover:bg-hover"}`}
                  title={maximized ? t("titleBar.restore", { defaultValue: "Restore" }) : t("titleBar.maximize", { defaultValue: "Maximize" })}
                  aria-label={maximized ? t("titleBar.restore", { defaultValue: "Restore" }) : t("titleBar.maximize", { defaultValue: "Maximize" })}
                >
                  {maximized
                    ? <Copy className="w-3.5 h-3.5 text-text-secondary pointer-events-none scale-x-[-1]" />
                    : <Square className="w-4 h-4 text-text-secondary pointer-events-none" />
                  }
                </button>
                <button
                  onClick={handleCloseRequest}
                  className="inline-flex items-center justify-center w-11 h-full hover:bg-danger/90 hover:text-white transition-colors"
                  title={t("titleBar.close", { defaultValue: "Close" })}
                  aria-label={t("titleBar.close", { defaultValue: "Close" })}
                >
                  <X className="w-4 h-4 text-text-secondary pointer-events-none" />
                </button>
              </div>
            )}
          </div>

          {ready && initData ? (
            <ComposeForm
              ref={composeFormRef}
              isOpen={true}
              onClose={handleClose}
              mode={initData.mode}
              originalMail={initData.originalMail}
              initData={initData}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center">
              <div className="animate-pulse text-text-tertiary text-sm">{t("common.loading")}</div>
            </div>
          )}
      </div>
      {/* Each webview has its own store instance — without this, toasts raised
          inside the compose window (attachment failures etc.) are never shown. */}
      <ToastContainer />
    </DialogProvider>
    </QueryClientProvider>
  );
}
