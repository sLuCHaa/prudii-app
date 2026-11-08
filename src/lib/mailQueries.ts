import type { QueryClient } from "@tanstack/react-query";
import type { SearchResult } from "../types";

/**
 * Every query that feeds a mail list, plus the folder counts.
 *
 * A mail leaving a folder changes all of them at once — the folder's own list,
 * the filtered and combined views, the category views and their counters — and which of them is on
 * screen is not something an action handler should have to know.
 */
export const MAIL_LIST_QUERY_KEYS = [
  "folders",
  "mails",
  "filtered-mails",
  "all-inbox-mails",
  "combined-folder-mails",
  "category-mails",
  "category-counts",
] as const;

/**
 * Refetch the lists after a mail moved out of the current folder.
 *
 * Skipping this does not merely leave the counts stale: the list holds a row
 * that is sweeping out only while it is in `pendingRemoveIds`, and clearing
 * that set re-syncs the list from the query data. Without a refetch that data
 * still contains the mail, so the row reappears the moment its tween ends.
 */
export function invalidateMailListQueries(queryClient: QueryClient): void {
  for (const key of MAIL_LIST_QUERY_KEYS) {
    queryClient.invalidateQueries({ queryKey: [key] });
  }
}

/** Search results are not mail lists: their read marks follow the mails by hand. */
export function patchSearchRead(queryClient: QueryClient, mailIds: readonly string[], isRead: boolean): void {
  const ids = new Set(mailIds);
  const patch = (rows: SearchResult[] | undefined) =>
    rows?.map((r) => (ids.has(r.mail_id) && r.is_read !== isRead ? { ...r, is_read: isRead } : r));
  queryClient.setQueriesData<SearchResult[]>({ queryKey: ["search"] }, patch);
  queryClient.setQueriesData<SearchResult[]>({ queryKey: ["search-server"] }, patch);
}
