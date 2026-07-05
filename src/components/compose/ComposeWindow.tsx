import { useState, useEffect, useRef } from "react";
import { X, Maximize2, Minimize2, Pencil, Reply, ReplyAll, Forward } from "lucide-react";
import { listen, emit } from "@tauri-apps/api/event";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalSize, LogicalPosition } from "@tauri-apps/api/dpi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { DialogProvider } from "../ui/DialogProvider";
import { ComposeForm } from "./ComposeModal";
import type { ComposeInitData, ComposeMode, ComposeFormHandle } from "./ComposeModal";
import { isMacOS } from "../../lib/platform";

// Standalone QueryClient for the compose window (needed because ComposeForm
// internally calls useAccounts() which requires a QueryClientProvider context).
const composeQueryClient = new QueryClient();

export function ComposeWindow() {
  const { t } = useTranslation();
  const [initData, setInitData] = useState<ComposeInitData | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!initData) return;
    const { appSettings, darkMode } = initData;
    document.documentElement.classList.toggle("dark", darkMode);
    document.documentElement.setAttribute("data-accent", appSettings.accent_color);
    document.documentElement.setAttribute("data-density", appSettings.density);
    // Window was created hidden — show it now that content + theme are ready.
    // The window's native background color (set at creation in composeWindow.ts)
    // prevents a white flash before the web content paints.
    const win = getCurrentWindow();
    win.show().then(() => win.setFocus());
  }, [initData]);

  useEffect(() => {
    const win = getCurrentWindow();

    const unlisten = listen<ComposeInitData>("compose-init", (event) => {
      setInitData(event.payload);
      setReady(true);
    });

    // Signal to the main window that we're mounted and listening
    emit("compose-ready", win.label);

    return () => { unlisten.then((fn) => fn()); };
  }, []);

  const composeFormRef = useRef<ComposeFormHandle>(null);
  const closeUnlistenRef = useRef<(() => void) | null>(null);
  // Set once the close is confirmed, so the (asynchronously-unregistered)
  // close-requested interceptor below doesn't re-open the discard dialog when
  // getCurrentWindow().close() fires another close-requested event.
  const closingRef = useRef(false);

  const [maximized, setMaximized] = useState(false);
  const savedBounds = useRef<{ w: number; h: number; x: number; y: number } | null>(null);
  const resizing = useRef(false);

  // Detect native maximize (e.g. double-click on title bar) via resize events
  useEffect(() => {
    const win = getCurrentWindow();
    const unlisten = win.onResized(async () => {
      if (resizing.current) return; // ignore our own resizes
      try {
        const scale = (await currentMonitor())?.scaleFactor ?? 1;
        const size = await win.outerSize();
        const w = Math.round(size.width / scale);
        const h = Math.round(size.height / scale);
        const availW = window.screen.availWidth;
        const availH = window.screen.availHeight;
        const isMax = w >= availW - 10 && h >= availH - 10;
        if (isMax && !maximized) {
          // Window was just maximized externally — save the previous bounds
          // (savedBounds was set before the resize, so it holds the normal-size bounds)
          setMaximized(true);
        } else if (!isMax && maximized) {
          setMaximized(false);
        }
      } catch { /* ignore */ }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [maximized]);

  // Save bounds continuously while in normal state so we always have a restore target
  useEffect(() => {
    if (maximized) return;
    let cancelled = false;
    (async () => {
      try {
        const win = getCurrentWindow();
        const scale = (await currentMonitor())?.scaleFactor ?? 1;
        const size = await win.outerSize();
        const pos = await win.outerPosition();
        if (cancelled) return;
        savedBounds.current = {
          w: Math.round(size.width / scale),
          h: Math.round(size.height / scale),
          x: Math.round(pos.x / scale),
          y: Math.round(pos.y / scale),
        };
      } catch { /* ignore */ }
    })();
    return () => { cancelled = true; };
  }, [maximized]);

  async function handleToggleMaximize() {
    const win = getCurrentWindow();
    resizing.current = true;
    try {
      if (maximized) {
        if (savedBounds.current) {
          const { w, h, x, y } = savedBounds.current;
          await win.setPosition(new LogicalPosition(x, y));
          await win.setSize(new LogicalSize(w, h));
        }
        setMaximized(false);
      } else {
        const scale = (await currentMonitor())?.scaleFactor ?? 1;
        const size = await win.outerSize();
        const pos = await win.outerPosition();
        savedBounds.current = {
          w: Math.round(size.width / scale),
          h: Math.round(size.height / scale),
          x: Math.round(pos.x / scale),
          y: Math.round(pos.y / scale),
        };
        // Use available screen area (respects dock + menu bar dynamically)
        const availX = (window.screen as any).availLeft ?? 0;
        const availY = (window.screen as any).availTop ?? 0;
        const availW = window.screen.availWidth;
        const availH = window.screen.availHeight;
        await win.setPosition(new LogicalPosition(availX, availY));
        await win.setSize(new LogicalSize(availW, availH));
        setMaximized(true);
      }
    } finally {
      setTimeout(() => { resizing.current = false; }, 200);
    }
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
      <div className="flex flex-col h-screen bg-surface text-text">
          {/* macOS: left padding clears the native traffic lights (overlay title bar) */}
          <div
            data-tauri-drag-region
            className={`flex items-center justify-between py-2 pr-4 border-b border-border bg-bg-secondary select-none shrink-0 ${isMacOS ? "pl-[88px]" : "pl-4"}`}
          >
            <h2 data-tauri-drag-region className="flex items-center gap-2 text-sm font-semibold text-text">
              <ModeIcon className="w-4 h-4 text-accent shrink-0" />
              {modeTitle}
            </h2>
            {/* macOS uses the native traffic lights instead (overlay title bar) */}
            {!isMacOS && (
              <div className="flex items-center gap-1">
                <button
                  onClick={handleToggleMaximize}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-lg hover:bg-hover transition-colors text-text-tertiary"
                >
                  {maximized
                    ? <Minimize2 className="w-3.5 h-3.5 pointer-events-none" />
                    : <Maximize2 className="w-3.5 h-3.5 pointer-events-none" />
                  }
                </button>
                <button
                  onClick={handleCloseRequest}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-text-tertiary hover:bg-danger hover:text-white transition-colors"
                >
                  <X className="w-4 h-4 pointer-events-none" />
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
    </DialogProvider>
    </QueryClientProvider>
  );
}
