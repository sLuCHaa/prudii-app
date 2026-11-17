import { useState, useEffect, useRef } from "react";
import type { TFunction } from "i18next";
import { Check, X, Send } from "../icons";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";
import { emit } from "@tauri-apps/api/event";
import { useAppStore, type UndoSendState } from "../../stores/appStore";
import { sendMail, saveDraft, syncAccount, deleteMailPermanently } from "../../lib/tauri";
import { causeMessage } from "../../lib/errorToast";
import { playSentSound } from "../../lib/sounds";
import { undoSendStep } from "../../lib/undoSendStep";
import type { SendMailRequest } from "../../types";

type Phase = "countdown" | "sending" | "sent" | "error";

/** Throws when the send fails; a failed draft cleanup only warns. */
async function deliver(u: UndoSendState, request: SendMailRequest, t: TFunction): Promise<void> {
  await sendMail(request);
  // Awaited: it queues the server-side delete as a pending op, and the sync below
  // only runs those before re-fetching the folders. Starting the sync first lets
  // it re-import the draft that is still sitting in the server's Drafts folder.
  if (u.composeMode === "draft" && u.composeMail) {
    await deleteMailPermanently(u.composeMail.id).catch((err) => {
      console.error("draft cleanup after send failed", err);
      useAppStore.getState().addToast(
        "warning",
        t("undoSend.draftCleanupFailedTitle"),
        err instanceof Error ? err.message : String(err),
      );
    });
  }
  // The deleted draft is already gone from the local DB — show that now instead
  // of waiting for the sync; the sent copy emits its own event once it lands.
  emit("mails-changed", { account_id: request.account_id });
  syncAccount(request.account_id).catch(() => {});
}

// The compose window is long gone, so the request is the only copy of the message.
async function parkAsDraft(request: SendMailRequest): Promise<boolean> {
  try {
    await saveDraft(request);
    emit("mails-changed", { account_id: request.account_id });
    return true;
  } catch (err) {
    console.error("[undoSend] draft backstop failed", err);
    return false;
  }
}

const isCurrent = (request: SendMailRequest) => useAppStore.getState().undoSend.request === request;

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
  const pendingRef = useRef<UndoSendState | null>(null);
  const lastRequestRef = useRef<SendMailRequest | null>(null);

  // A newer send can take over the pill while this one is still on its way: only the current one may touch it.
  async function sendNow(u: UndoSendState) {
    const request = u.request;
    if (!request) return;
    if (isCurrent(request)) setPhase("sending");
    try {
      await deliver(u, request, t);
      if (useAppStore.getState().appSettings.notification_sound) playSentSound();
      if (!isCurrent(request)) return;
      setPhase("sent");
      setTimeout(() => {
        if (isCurrent(request)) clearUndoSend();
      }, 2000);
    } catch (err) {
      console.error("[undoSend]", err);
      const savedAsDraft = await parkAsDraft(request);
      if (isCurrent(request)) {
        setDraftSaved(savedAsDraft);
        setErrorMsg(causeMessage(err));
        setPhase("error");
      } else {
        useAppStore.getState().addToast(
          "error",
          t("undoSend.sendFailedTitle"),
          `${causeMessage(err)}${savedAsDraft ? ` ${t("undoSend.savedAsDraft")}` : ""}`,
        );
      }
    }
  }
  const sendNowRef = useRef(sendNow);
  sendNowRef.current = sendNow;

  useEffect(() => {
    const step = undoSendStep(pendingRef.current, lastRequestRef.current, undoSend);
    if (step.flush) void sendNowRef.current(step.flush);

    if (!undoSend.active) {
      pendingRef.current = null;
      lastRequestRef.current = null;
      setPhase("countdown");
      setProgress(1);
      return;
    }
    if (step.countdown === "none") return;
    if (step.countdown === "start") {
      pendingRef.current = undoSend;
      lastRequestRef.current = undoSend.request;
      startTimeRef.current = Date.now();
      setPhase("countdown");
      setProgress(1);
    }

    const counting = undoSend;
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const remaining = 1 - elapsed / COUNTDOWN_MS;
      if (remaining <= 0) {
        if (timerRef.current) clearInterval(timerRef.current);
        timerRef.current = null;
        pendingRef.current = null;
        setProgress(0);
        void sendNowRef.current(counting);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoSend]);

  function handleUndo() {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    cancelUndoSend();
  }

  // Reopens a compose window with the full snapshot — same path as Undo.
  function handleRestore() {
    setPhase("countdown");
    cancelUndoSend();
  }

  function handleDismissError() {
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
          className="fixed bottom-6 left-1/2 -translate-x-1/2 z-100 overflow-hidden rounded-xl bg-surface border border-border shadow-lg inset-shadow-edge min-w-[340px] max-w-[440px]"
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
