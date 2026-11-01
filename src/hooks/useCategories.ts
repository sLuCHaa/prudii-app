import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { categorizePendingMails, getMailCategoryInfo, listCategoryCounts, listCategoryMails, setMailCategory } from "../lib/tauri";
import type { CategoryCount, Mail, MailCategoryInfo } from "../types";
import type { MailSort } from "../lib/mailSort";

const PAGE_SIZE = 100;

export const CATEGORY_QUERY_KEYS = [
  ["mails"],
  ["all-inbox-mails"],
  ["filtered-mails"],
  ["combined-folder-mails"],
  ["category-mails"],
  ["category-counts"],
  ["mail-category-info"],
] as const;

function invalidateCategoryQueries(queryClient: QueryClient) {
  for (const queryKey of CATEGORY_QUERY_KEYS) {
    queryClient.invalidateQueries({ queryKey });
  }
}

export function useCategoryMails(category: string | null, folderId: string | null, folderFilter: string | undefined, sort: MailSort) {
  const filterKey = folderFilter && folderFilter !== "all" ? folderFilter : undefined;
  return useInfiniteQuery<Mail[]>({
    queryKey: ["category-mails", category, folderId, filterKey, sort],
    queryFn: ({ pageParam = 0 }) => listCategoryMails(category!, folderId, PAGE_SIZE, pageParam as number, filterKey, sort),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.flat().length,
    enabled: !!category,
    staleTime: 0,
  });
}

export function useCategoryCounts(enabled: boolean) {
  return useQuery<CategoryCount[]>({
    queryKey: ["category-counts"],
    queryFn: listCategoryCounts,
    enabled,
  });
}

export function useMailCategoryInfo(mailId: string | null) {
  return useQuery<MailCategoryInfo | null>({
    queryKey: ["mail-category-info", mailId],
    queryFn: () => getMailCategoryInfo(mailId!),
    enabled: !!mailId,
  });
}

export function useSetMailCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ mailId, category, rememberSender }: { mailId: string; category: string | null; rememberSender: boolean }) =>
      setMailCategory(mailId, category, rememberSender),
    onSuccess: () => invalidateCategoryQueries(queryClient),
  });
}

export async function runCategorization(queryClient: QueryClient): Promise<number> {
  const n = await categorizePendingMails();
  if (n > 0) invalidateCategoryQueries(queryClient);
  return n;
}
