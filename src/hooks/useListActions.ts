import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useAppStore } from "../stores/appStore";
import { useDialog } from "../components/ui/DialogProvider";
import { allowListAgain, blockSender, retryUnsubscribe, unsubscribeMail } from "../lib/tauri";
import { invalidateMailListQueries } from "../lib/mailQueries";
import { causeMessage } from "../lib/errorToast";
import type { UnsubscribeOutcome } from "../types";

/** Unsubscribe, block, retry and allow again behave the same in the reading pane and the inbox check. */
export function useListActions(onSettled: () => void) {
  const { t } = useTranslation();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);

  const showError = useCallback((e: unknown) => {
    const raw = String(e);
    dialog.alert({ type: "danger", title: t("common.error"), message: raw.startsWith("unsubscribe.errors.") ? t(raw) : causeMessage(e) });
  }, [dialog, t]);

  const applyOutcome = useCallback((outcome: UnsubscribeOutcome) => {
    if (outcome.web_url) openUrl(outcome.web_url).catch(() => {});
    if (outcome.trashed > 0) {
      addToast("success", t("unsubscribe.movedToTrash", { count: outcome.trashed }));
      invalidateMailListQueries(queryClient);
    }
  }, [addToast, queryClient, t]);

  const unsubscribeOrBlock = useCallback(async (mode: "unsubscribe" | "block", mailId: string, trashExisting: boolean) => {
    try {
      const run = mode === "block" ? blockSender : unsubscribeMail;
      applyOutcome(await run(mailId, trashExisting));
    } catch (e) {
      showError(e);
    } finally {
      onSettled();
    }
  }, [applyOutcome, showError, onSettled]);

  const listAction = useCallback(async (action: "retry" | "allow", id: string, name: string) => {
    if (action === "allow") {
      const confirmed = await dialog.confirm({
        title: t("unsubscribe.allowAgainTitle", { name }),
        message: t("unsubscribe.allowAgainMessage"),
        confirmLabel: t("unsubscribe.allowAgain"),
      });
      if (!confirmed) return;
    }
    try {
      if (action === "allow") await allowListAgain(id);
      else applyOutcome(await retryUnsubscribe(id));
    } catch (e) {
      showError(e);
    } finally {
      onSettled();
    }
  }, [dialog, t, applyOutcome, showError, onSettled]);

  return { unsubscribeOrBlock, listAction };
}
