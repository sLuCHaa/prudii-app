import { useState, useEffect, useRef, useCallback } from "react";
import { Check, X, Loader2 } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { useTranslation } from "react-i18next";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../../stores/appStore";
import { sendMail, syncAccount, trashMail } from "../../lib/tauri";
import { GlowRing } from "../motion/GlowRing";

type Phase = "countdown" | "sending" | "sent" | "error";

export function UndoToast() {
  const { t } = useTranslation();
  const undoSend = useAppStore((s) => s.undoSend);
  const cancelUndoSend = useAppStore((s) => s.cancelUndoSend);
  const clearUndoSend = useAppStore((s) => s.clearUndoSend);
  const undoSendDelay = useAppStore((s) => s.appSettings.undo_send_delay);
  const COUNTDOWN_MS = undoSendDelay * 1000;

  const [phase, setPhase] = useState<Phase>("countdown");
  const [progress, setProgress] = useState(1);
  const [errorMsg, setErrorMsg] = useState("");
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const activeRef = useRef(false);

  const doSend = useCallback(async () => {
    if (!undoSend.request) return;
    setPhase("sending");
    try {
      await sendMail(undoSend.request);
      // Sent from a saved draft — remove the original draft (moves it to Trash).
      // Awaited: it queues the server-side move as a pending op, and the sync below
      // only runs those before re-fetching the folders. Starting the sync first lets
      // it re-import the draft that is still sitting in the server's Drafts folder.
      if (undoSend.composeMode === "draft" && undoSend.composeMail) {
        await trashMail(undoSend.composeMail.id).catch((err) => {
          console.error("draft cleanup after send failed", err);
          useAppStore.getState().addToast(
            "warning",
            t("undoSend.draftCleanupFailedTitle"),
            err instanceof Error ? err.message : String(err),
          );
        });
      }
      // The sent mail and the trashed draft are already in the local DB — show them
      // now instead of waiting for the sync that follows to report back.
      emit("mails-changed", { account_id: undoSend.request.account_id });
      syncAccount(undoSend.request.account_id).catch(() => {});
      setPhase("sent");
      setTimeout(() => {
        clearUndoSend();
      }, 2000);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
      setPhase("error");
      setTimeout(() => {
        clearUndoSend();
      }, 5000);
    }
  }, [undoSend.request, clearUndoSend]);

  useEffect(() => {
    if (!undoSend.active) {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
      activeRef.current = false;
      setPhase("countdown");
      setProgress(1);
      return;
    }

    // Already running — don't restart
    if (activeRef.current) return;
    activeRef.current = true;
    setPhase("countdown");
    setProgress(1);

    startTimeRef.current = Date.now();
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const remaining = 1 - elapsed / COUNTDOWN_MS;
      if (remaining <= 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        setProgress(0);
        doSend();
      } else {
        setProgress(remaining);
      }
    }, 50);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
        timerRef.current = null;
      }
    };
  }, [undoSend.active, doSend]);

  function handleUndo() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    activeRef.current = false;
    cancelUndoSend();
  }

  const visible = undoSend.active || phase === "sending" || phase === "sent" || phase === "error";

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 60 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 60 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-100 flex items-center gap-3 px-4 py-3 rounded-xl bg-surface border border-border shadow-lg min-w-[280px]"
        >
          {phase === "countdown" && (
            <>
              <GlowRing progress={progress} size={28} strokeWidth={3}>
                <span className="text-[10px] font-bold text-accent tabular-nums">
                  {Math.ceil(progress * undoSendDelay)}
                </span>
              </GlowRing>
              <span className="text-sm text-text flex-1">{t("undoSend.sending")}</span>
              <button
                onClick={handleUndo}
                className="px-3 py-1 rounded-lg text-sm font-medium text-accent hover:bg-accent/10 transition-colors"
              >
                {t("undoSend.undo")}
              </button>
            </>
          )}

          {phase === "sending" && (
            <>
              <Loader2 className="w-5 h-5 text-accent animate-spin shrink-0" />
              <span className="text-sm text-text">{t("common.sending")}</span>
            </>
          )}

          {phase === "sent" && (
            <>
              <div className="w-6 h-6 rounded-full bg-success/20 flex items-center justify-center shrink-0">
                <Check className="w-4 h-4 text-success" />
              </div>
              <span className="text-sm text-text">{t("undoSend.messageSent")}</span>
            </>
          )}

          {phase === "error" && (
            <>
              <div className="w-6 h-6 rounded-full bg-danger/20 flex items-center justify-center shrink-0">
                <X className="w-4 h-4 text-danger" />
              </div>
              <span className="text-sm text-danger truncate max-w-[300px]">{errorMsg}</span>
            </>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
