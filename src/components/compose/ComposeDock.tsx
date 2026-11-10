import { useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { AppWindow, Forward, Minus, Pencil, Reply, ReplyAll, Square, X } from "../icons";
import { ComposeForm } from "./ComposeModal";
import type { ComposeFormHandle, ComposeInitData } from "./ComposeModal";
import { openComposeWindow } from "../../lib/composeWindow";
import { deleteComposeAutosave } from "../../lib/tauri";

/** The compose form docked into the main window, for those who would rather not have a window of its own. */
export function ComposeDock({ data, onClosed }: { data: ComposeInitData; onClosed: () => void }) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<ComposeFormHandle>(null);
  const [collapsed, setCollapsed] = useState(false);

  const close = useCallback(() => {
    // The form autosaves under the window's label; a clean exit must not leave that behind to be offered at the next start.
    deleteComposeAutosave(getCurrentWindow().label).catch(() => {});
    onClosed();
  }, [onClosed]);

  function popOut() {
    const snapshot = formRef.current?.snapshot();
    if (!snapshot) return;
    void openComposeWindow({ ...data, mailtoParams: null, aiReplyText: null, snapshot });
    close();
  }

  const mode = data.mode;
  const title = mode === "new" ? t("compose.newMessage") : mode === "draft" ? t("compose.draft") : mode === "reply" ? t("compose.reply") : mode === "replyAll" ? t("compose.replyAll") : t("compose.forward");
  const ModeIcon = mode === "reply" ? Reply : mode === "replyAll" ? ReplyAll : mode === "forward" ? Forward : Pencil;
  const foldLabel = t(collapsed ? "compose.dock.expand" : "compose.dock.collapse");
  const button = "inline-flex items-center justify-center w-10 h-full hover:bg-hover transition-colors";

  return (
    <div
      ref={rootRef}
      role="dialog"
      aria-label={title}
      className="fixed bottom-0 right-6 z-40 w-[min(600px,calc(100vw-48px))] flex flex-col bg-surface text-text border border-b-0 border-border rounded-t-xl shadow-lg inset-shadow-edge overflow-hidden"
      style={collapsed ? undefined : { height: "min(660px, calc(100vh - 96px))" }}
    >
      <div
        onDoubleClick={() => setCollapsed((c) => !c)}
        className="flex items-center justify-between h-9 pl-4 border-b border-border bg-bg-secondary select-none shrink-0"
      >
        <h2 className="flex items-center gap-2 min-w-0 text-sm font-semibold text-text">
          <ModeIcon className="w-4 h-4 text-accent shrink-0" />
          <span className="truncate">{title}</span>
        </h2>
        <div className="flex h-full items-stretch shrink-0" onDoubleClick={(e) => e.stopPropagation()}>
          <button type="button" onClick={() => setCollapsed((c) => !c)} className={button} title={foldLabel} aria-label={foldLabel} aria-expanded={!collapsed}>
            {collapsed ? <Square className="w-3.5 h-3.5 text-text-secondary" /> : <Minus className="w-4 h-4 text-text-secondary" />}
          </button>
          <button type="button" onClick={popOut} className={button} title={t("compose.dock.popOut")} aria-label={t("compose.dock.popOut")}>
            <AppWindow className="w-4 h-4 text-text-secondary" />
          </button>
          <button
            type="button"
            onClick={() => formRef.current?.requestClose()}
            className="inline-flex items-center justify-center w-10 h-full hover:bg-danger/90 hover:text-white transition-colors"
            title={t("titleBar.close", { defaultValue: "Close" })}
            aria-label={t("titleBar.close", { defaultValue: "Close" })}
          >
            <X className="w-4 h-4 text-text-secondary pointer-events-none" />
          </button>
        </div>
      </div>

      <div className={collapsed ? "hidden" : "flex-1 min-h-0 flex flex-col"}>
        <ComposeForm
          ref={formRef}
          isOpen={true}
          onClose={close}
          mode={data.mode}
          originalMail={data.originalMail}
          initData={data}
          dockRoot={rootRef}
        />
      </div>
    </div>
  );
}
