import type { Folder } from "../types";

export interface StarView {
  hideStarredInInbox: boolean;
  showAllInboxes: boolean;
  activeCategory: string | null;
  activeFilter: string | null;
  folderFilter: string;
  searchOpen: boolean;
  selectedFolderId: string | null;
  folders: Pick<Folder, "id" | "folder_type">[];
}

/** Whether a mail that has just been starred leaves the list on screen: the inbox can hand starred mails to the Starred view. */
export function leavesViewWhenStarred(view: StarView): boolean {
  if (!view.hideStarredInInbox || view.searchOpen || view.activeFilter || view.folderFilter === "starred") return false;
  if (view.showAllInboxes || view.activeCategory) return true;
  return view.folders.some((f) => f.id === view.selectedFolderId && f.folder_type === "inbox");
}
