import { useEffect, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
import i18next from "i18next";
import type { TFunction } from "i18next";
import { useAppStore } from "../stores/appStore";
import { useDialog } from "../components/ui/DialogProvider";
import { exportNeedsAttention, exportResultMessage, exportResultTitle } from "../lib/mailExport";
import { cancelMailExport, hideToTray, mailExportRunning, openLastExportFolder, quitApp } from "../lib/tauri";
import type { ExportProgress, ExportSummary } from "../types";

const QUIT_WAIT_MS = 10_000;

interface QuitDialog {
  danger: (options: { title: string; message: string; confirmLabel?: string }) => Promise<boolean>;
}

export async function confirmQuitDuringExport(dialog: QuitDialog, t: TFunction): Promise<boolean> {
  const confirmed = await dialog.danger({
    title: t("mailExport.quitTitle"),
    message: t("mailExport.quitMessage"),
    confirmLabel: t("mailExport.quitConfirm"),
  });
  if (!confirmed) return false;

  let finish: () => void = () => {};
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const unlisten = await listen("mail-export-done", () => finish());
  const timer = setTimeout(finish, QUIT_WAIT_MS);
  try {
    await cancelMailExport().catch(() => {});
    await done;
  } finally {
    clearTimeout(timer);
    unlisten();
  }
  return true;
}

export async function closeOrHide(showInTray: boolean, dialog: QuitDialog, t: TFunction): Promise<void> {
  if (showInTray && (await hideToTray().then(() => true, () => false))) return;
  if (useAppStore.getState().mailExport.running) {
    const quit = await confirmQuitDuringExport(dialog, t).catch(() => false);
    if (!quit) return;
  }
  await quitApp().catch(() => {});
}

function showDoneNotice(summary: ExportSummary) {
  const t = i18next.t.bind(i18next) as TFunction;
  useAppStore.getState().addToast(
    exportNeedsAttention(summary) ? "warning" : "success",
    exportResultTitle(t, summary),
    exportResultMessage(t, summary),
    undefined,
    { label: t("mailExport.openFolder"), onClick: () => { void openLastExportFolder(); } },
    true,
  );
}

export function useMailExportEvents() {
  const dialog = useDialog();
  const dialogRef = useRef(dialog);
  dialogRef.current = dialog;

  useEffect(() => {
    const setMailExport = useAppStore.getState().setMailExport;
    let quitPromptOpen = false;

    const unlisten = [
      listen<ExportProgress>("mail-export-progress", (event) => {
        setMailExport({ running: true, progress: event.payload });
      }),
      listen<ExportSummary>("mail-export-done", (event) => {
        setMailExport({ running: false, progress: null, result: event.payload });
        showDoneNotice(event.payload);
      }),
      listen("mail-export-quit-requested", async () => {
        if (quitPromptOpen) return;
        quitPromptOpen = true;
        try {
          if (await confirmQuitDuringExport(dialogRef.current, i18next.t.bind(i18next) as TFunction)) await quitApp();
        } finally {
          quitPromptOpen = false;
        }
      }),
    ];

    mailExportRunning().then((running) => {
      if (running) setMailExport({ running: true });
    }).catch(() => {});

    return () => {
      unlisten.forEach((p) => p.then((fn) => fn()));
    };
  }, []);
}
