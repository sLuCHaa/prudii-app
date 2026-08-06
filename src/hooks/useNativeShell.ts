import { useEffect, useMemo } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useAccounts } from "./useAccounts";
import { useQueries } from "@tanstack/react-query";
import { useAppStore } from "../stores/appStore";
import { setDockBadge, listFolders } from "../lib/tauri";
import { useTranslation } from "react-i18next";

/** Mirrors app state into the OS shell: dock badge + window title. */
export function useNativeShell(): void {
  const { t } = useTranslation();
  const { data: accounts } = useAccounts();
  const selectedFolderId = useAppStore((s) => s.selectedFolderId);
  const showAllInboxes = useAppStore((s) => s.showAllInboxes);

  const folderQueries = useQueries({
    queries: (accounts ?? []).map((account) => ({
      queryKey: ["folders", account.id],
      queryFn: () => listFolders(account.id),
    })),
  });

  const allFolders = useMemo(() => {
    return folderQueries
      .flatMap((query) => query.data || []);
  }, [folderQueries]);

  const inboxUnread = useMemo(() => {
    return allFolders
      .filter((f) => f.folder_type === "inbox")
      .reduce((sum, f) => sum + (f.unread_count ?? 0), 0);
  }, [allFolders]);

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
