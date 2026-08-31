import { useState, useEffect, useRef, useCallback } from "react";
import { Check, X, Send } from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "../../stores/appStore";
import { sendMail, saveDraft, syncAccount, trashMail } from "../../lib/tauri";
import { causeMessage } from "../../lib/errorToast";
import { playSentSound } from "../../lib/sounds";

type Phase = "countdown" | "sending" | "sent" | "error";

export function UndoToast() {
  const { t } = useTranslation();
  const reduceMotion = useReducedMotion();
  const undoSend = useAppStore((s) => s.undoSend);
  const cancelUndoSend = useAppStore((s) => s.cancelUndoSend);
  const clearUndoSend = useAppStore((s) => s.clearUndoSend);
  const undoSendDelay = useAppStore((s) => s.appSettings.undo_send_delay);
  const COUNTDOWN_MS = undoSendDelay * 1000;

  const [phase, setPhase] = useState<Phase>("countdown");
  const [progress, setProgress] = useState(1);
  const [errorMsg, setErrorMsg] = useState("");
  const [draftSaved, setDraftSaved] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef(0);
  const activeRef = useRef(false);
  // A new send can arrive while the pill still shows the previous outcome
  // (the error phase persists until dismissed) — a changed request must
  // restart the countdown even though activeRef is still true.
  const lastRequestRef = useRef<typeof undoSend.request>(null);

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
      if (useAppStore.getState().appSettings.notification_sound) playSentSound();
      setPhase("sent");
      setTimeout(() => {
        clearUndoSend();
      }, 2000);
    } catch (err) {
      console.error("[undoSend]", err);
      // The compose window is long gone — the snapshot in the store is the only
      // copy of the message. Park it in Drafts so nothing can be lost, then keep
      // the pill up (no auto-dismiss) with a one-click restore.
      const savedAsDraft = await saveDraft(undoSend.request)
        .then(() => {
          emit("mails-changed", { account_id: undoSend.request!.account_id });
          return true;
        })
        .catch((draftErr) => {
          console.error("[undoSend] draft backstop failed", draftErr);
          return false;
        });
      setDraftSaved(savedAsDraft);
      setErrorMsg(causeMessage(err));
      setPhase("error");
    }
  }, [undoSend.request, undoSend.composeMode, undoSend.composeMail, clearUndoSend, t]);

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

    // Already running for this request — don't restart
    if (activeRef.current && lastRequestRef.current === undoSend.request) return;
    activeRef.current = true;
    lastRequestRef.current = undoSend.request;
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

  // Reopens a compose window with the full snapshot — same path as Undo.
  function handleRestore() {
    activeRef.current = false;
    setPhase("countdown");
    cancelUndoSend();
  }

  function handleDismissError() {
    activeRef.current = false;
    setPhase("countdown");
    clearUndoSend();
  }

  const visible = undoSend.active || phase === "sending" || phase === "sent" || phase === "error";
  const subject = undoSend.request?.subject ?? "";
  const secondsLeft = Math.ceil(progress * undoSendDelay);

  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0, y: 60, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 60, scale: 0.96 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-100 overflow-hidden rounded-xl bg-surface border border-border shadow-lg min-w-[340px] max-w-[440px]"
        >
          <div className="flex items-center gap-3 px-4 py-3">
            {(phase === "countdown" || phase === "sending") && (
              <>
                <div className="relative w-9 h-9 rounded-full bg-accent/10 flex items-center justify-center shrink-0">
                  <motion.div
                    animate={
                      reduceMotion
                        ? undefined
                        : phase === "sending"
                          ? { x: [0, 3, 0], y: [0, -3, 0] }
                          : { y: [0, -1.5, 0] }
                    }
                    transition={{ duration: phase === "sending" ? 0.7 : 2, repeat: Infinity, ease: "easeInOut" }}
                  >
                    <Send className="w-4 h-4 text-accent" />
                  </motion.div>
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text">
                    {phase === "sending" ? t("common.sending") : t("undoSend.sending")}
                  </p>
                  {subject && (
                    <p className="text-xs text-text-tertiary truncate mt-0.5">{subject}</p>
                  )}
                </div>
                {phase === "countdown" && (
                  <button
                    onClick={handleUndo}
                    className="shrink-0 px-3.5 py-1.5 rounded-lg text-sm font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                  >
                    {t("undoSend.undo")}
                    <span className="ml-1.5 tabular-nums text-accent/70">{secondsLeft}</span>
                  </button>
                )}
              </>
            )}

            {phase === "sent" && (
              <>
                <motion.div
                  initial={reduceMotion ? false : { scale: 0.4, rotate: -20 }}
                  animate={{ scale: 1, rotate: 0 }}
                  transition={{ type: "spring", stiffness: 500, damping: 18 }}
                  className="w-9 h-9 rounded-full bg-success/15 flex items-center justify-center shrink-0"
                >
                  <Check className="w-4.5 h-4.5 text-success" />
                </motion.div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text">{t("undoSend.messageSent")}</p>
                  {subject && (
                    <p className="text-xs text-text-tertiary truncate mt-0.5">{subject}</p>
                  )}
                </div>
              </>
            )}

            {phase === "error" && (
              <>
                <div className="w-9 h-9 rounded-full bg-danger/15 flex items-center justify-center shrink-0">
                  <X className="w-4 h-4 text-danger" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-text">{t("undoSend.sendFailedTitle")}</p>
                  <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">
                    {errorMsg}
                    {draftSaved ? ` ${t("undoSend.savedAsDraft")}` : ""}
                  </p>
                </div>
                <button
                  onClick={handleRestore}
                  className="shrink-0 px-3.5 py-1.5 rounded-lg text-sm font-medium bg-accent/10 text-accent hover:bg-accent/20 transition-colors"
                >
                  {t("undoSend.restore")}
                </button>
                <button
                  onClick={handleDismissError}
                  className="p-1 rounded hover:bg-hover transition-colors text-text-tertiary shrink-0"
                  aria-label={t("common.close")}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </>
            )}
          </div>

          {/* Draining time bar — the visual countdown. Width comes from the
              50ms progress tick; during the actual send it pulses instead. */}
          {(phase === "countdown" || phase === "sending") && (
            <div className="h-0.5 w-full bg-accent/15">
              {phase === "countdown" ? (
                <div
                  className="h-full bg-linear-to-r from-accent to-purple-500"
                  style={{ width: `${progress * 100}%` }}
                />
              ) : (
                <motion.div
                  className="h-full bg-linear-to-r from-accent to-purple-500"
                  animate={reduceMotion ? undefined : { opacity: [1, 0.4, 1] }}
                  transition={{ duration: 1, repeat: Infinity, ease: "easeInOut" }}
                />
              )}
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}
