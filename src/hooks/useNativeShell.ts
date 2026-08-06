import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAccounts } from "./useAccounts";
import { useAppStore } from "../stores/appStore";
import { setDockBadge, listFolders } from "../lib/tauri";
import { useTranslation } from "react-i18next";
import type { Folder } from "../types";

/** Mirrors app state into the OS shell: dock badge + window title. */
export function useNativeShell(): void {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const [allFolders, setAllFolders] = useState<Folder[]>([]);
  const selectedFolderId = useAppStore((s) => s.selectedFolderId);
  const showAllInboxes = useAppStore((s) => s.showAllInboxes);

  useEffect(() => {
    if (!accounts || accounts.length === 0) {
      setAllFolders([]);
      return;
    }

    Promise.all(accounts.map((account) => listFolders(account.id)))
      .then((results) => {
        const combined = results.flatMap((folders) => folders || []);
        setAllFolders(combined);
      })
      .catch(() => {});
  }, [accounts]);

  const inboxUnread = allFolders
    .filter((f) => f.folder_type === "inbox")
    .reduce((sum, f) => sum + (f.unread_count ?? 0), 0);

  useEffect(() => {
    setDockBadge(inboxUnread > 0 ? inboxUnread : null).catch(() => {});
  }, [inboxUnread]);

  useEffect(() => {
    const current = allFolders.find((f) => f.id === selectedFolderId);
    const base = showAllInboxes
      ? t("sidebar.allInboxes")
      : current?.name ?? "Prudii Mail";
    const title = inboxUnread > 0 ? `${base} (${inboxUnread})` : base;
    getCurrentWindow().setTitle(title).catch(() => {});
  }, [allFolders, selectedFolderId, showAllInboxes, inboxUnread, t]);
}
