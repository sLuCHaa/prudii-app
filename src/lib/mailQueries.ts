import type { InfiniteData, QueryClient } from "@tanstack/react-query";
import type { Mail, SearchResult } from "../types";
import { useAppStore } from "../stores/appStore";

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
  void refetchMailLists(queryClient);
}

function refetchMailLists(queryClient: QueryClient): Promise<unknown> {
  return Promise.all(MAIL_LIST_QUERY_KEYS.map((key) => queryClient.invalidateQueries({ queryKey: [key] })));
}

/** Released only after the refetch: any earlier and the list takes the rows back from a cache that still holds them. */
export async function holdUntilMoved<T>(queryClient: QueryClient, mailIds: string[], move: () => Promise<T>): Promise<T> {
  useAppStore.getState().holdMovedMails(mailIds);
  try {
    return await move();
  } finally {
    await refetchMailLists(queryClient);
    useAppStore.getState().releaseMovedMails(mailIds);
  }
}

/** Everything a restore may have replaced. */
export function invalidateRestoredData(queryClient: QueryClient): void {
  queryClient.invalidateQueries({ queryKey: ["accounts"] });
  queryClient.invalidateQueries({ queryKey: ["signatures"] });
  invalidateMailListQueries(queryClient);
}

export type MailFlagPatch = Partial<Pick<Mail, "is_read" | "is_starred">>;

const LIST_KEYS = MAIL_LIST_QUERY_KEYS.filter((k) => k !== "folders" && k !== "category-counts");

/**
 * Carry an optimistic read/star change into every cached list and search, so
 * switching to another view never shows (and animates) the old state first.
 */
export function patchCachedMails(queryClient: QueryClient, mailIds: readonly string[], patch: MailFlagPatch): void {
  const ids = new Set(mailIds);
  const patchMail = (m: Mail) => (ids.has(m.id) ? { ...m, ...patch } : m);
  for (const key of LIST_KEYS) {
    queryClient.setQueriesData<InfiniteData<Mail[]>>({ queryKey: [key] }, (data) =>
      data?.pages ? { ...data, pages: data.pages.map((page) => page.map(patchMail)) } : data,
    );
  }
  if (patch.is_read === undefined) return;
  const isRead = patch.is_read;
  const patchHit = (rows: SearchResult[] | undefined) =>
    rows?.map((r) => (ids.has(r.mail_id) && r.is_read !== isRead ? { ...r, is_read: isRead } : r));
  queryClient.setQueriesData<SearchResult[]>({ queryKey: ["search"] }, patchHit);
  queryClient.setQueriesData<SearchResult[]>({ queryKey: ["search-server"] }, patchHit);
}
