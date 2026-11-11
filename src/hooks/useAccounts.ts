import { useQuery, useInfiniteQuery, useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { listAccounts, createAccount, deleteAccount, listFolders, listMails, listFilteredMails, listAllInboxMails, listCombinedFolderMails, listSnoozedMails, countStarredMails, listAttachments, toggleStar, togglePin, toggleMailFlag, listRules, createRule, updateRule, deleteRule, applyRulesNow } from "../lib/tauri";
import type { CreateAccountRequest, CreateRuleRequest, Mail, MailFlag, MailRule } from "../types";
import { useAppStore, type MailFilter } from "../stores/appStore";
import type { MailSort } from "../lib/mailSort";
import { invalidateMailListQueries } from "../lib/mailQueries";
import { leavesViewWhenStarred } from "../lib/starredInbox";

const PAGE_SIZE = 100;

export function useAccounts() {
  return useQuery({
    queryKey: ["accounts"],
    queryFn: listAccounts,
  });
}

export function useCreateAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateAccountRequest) => createAccount(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}

export function useDeleteAccount() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => deleteAccount(accountId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    },
  });
}

export function useFolders(accountId: string | null) {
  return useQuery({
    queryKey: ["folders", accountId],
    queryFn: () => listFolders(accountId!),
    enabled: !!accountId,
  });
}

function folderMailsQuery(folderId: string | null, filterKey: string | undefined, sort: MailSort) {
  return {
    queryKey: ["mails", folderId, filterKey, sort],
    queryFn: ({ pageParam = 0 }: { pageParam?: unknown }) => listMails(folderId!, PAGE_SIZE, pageParam as number, filterKey, sort),
    initialPageParam: 0,
    getNextPageParam: (lastPage: Mail[], allPages: Mail[][]) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.flat().length,
  };
}

export function useMails(folderId: string | null, folderFilter: string | undefined, sort: MailSort) {
  const filterKey = folderFilter && folderFilter !== "all" ? folderFilter : undefined;
  return useInfiniteQuery<Mail[]>({
    ...folderMailsQuery(folderId, filterKey, sort),
    enabled: !!folderId,
    staleTime: 0,
  });
}

/** First page of a folder as opening it shows it (filter reset to "all"). */
export function prefetchFolderMails(queryClient: QueryClient, folderId: string, sort: MailSort) {
  return queryClient.prefetchInfiniteQuery<Mail[]>({
    ...folderMailsQuery(folderId, undefined, sort),
    staleTime: 5_000,
  });
}

export function useFilteredMails(filter: MailFilter, accountId: string | undefined, folderFilter: string | undefined, sort: MailSort) {
  const filterKey = folderFilter && folderFilter !== "all" ? folderFilter : undefined;
  return useInfiniteQuery<Mail[]>({
    queryKey: ["filtered-mails", filter, accountId, filterKey, sort],
    queryFn: ({ pageParam = 0 }) => listFilteredMails(filter!, accountId, PAGE_SIZE, pageParam as number, filterKey, sort),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.flat().length,
    enabled: !!filter,
    staleTime: 0,
  });
}

export function useAllInboxMails(enabled: boolean, folderFilter: string | undefined, sort: MailSort) {
  const filterKey = folderFilter && folderFilter !== "all" ? folderFilter : undefined;
  return useInfiniteQuery<Mail[]>({
    queryKey: ["all-inbox-mails", filterKey, sort],
    queryFn: ({ pageParam = 0 }) => listAllInboxMails(PAGE_SIZE, pageParam as number, filterKey, sort),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.flat().length,
    enabled,
    staleTime: 0,
  });
}

export function useCombinedFolderMails(folderType: string | null, folderFilter: string | undefined, sort: MailSort) {
  const filterKey = folderFilter && folderFilter !== "all" ? folderFilter : undefined;
  return useInfiniteQuery<Mail[]>({
    queryKey: ["combined-folder-mails", folderType, filterKey, sort],
    queryFn: ({ pageParam = 0 }) => listCombinedFolderMails(folderType!, PAGE_SIZE, pageParam as number, filterKey, sort),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.flat().length,
    enabled: !!folderType,
    staleTime: 0,
  });
}

export function useSnoozedMails(enabled: boolean) {
  return useInfiniteQuery<Mail[]>({
    queryKey: ["snoozed-mails"],
    queryFn: () => listSnoozedMails(undefined),
    initialPageParam: 0,
    getNextPageParam: () => undefined, // snoozed mails are not paginated
    enabled,
    staleTime: 0,
  });
}

export function useStarredCount(enabled: boolean) {
  return useQuery({
    queryKey: ["starred-count"],
    queryFn: countStarredMails,
    enabled,
    staleTime: 0,
  });
}

export function useAttachments(mailId: string | null) {
  return useQuery({
    queryKey: ["attachments", mailId],
    queryFn: () => listAttachments(mailId!),
    enabled: !!mailId,
    staleTime: 0,
  });
}

/** Whether starring a mail takes it out of the list that is open right now. */
export function starLeavesCurrentView(): boolean {
  const s = useAppStore.getState();
  return leavesViewWhenStarred({
    hideStarredInInbox: s.appSettings.hide_starred_in_inbox,
    showAllInboxes: s.showAllInboxes,
    activeCategory: s.activeCategory,
    activeFilter: s.activeFilter,
    folderFilter: s.folderFilter,
    searchOpen: s.searchOpen,
    selectedFolderId: s.selectedFolderId,
    folders: s.folders,
  });
}

export function useToggleStar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mailId: string) => toggleStar(mailId),
    onSuccess: (starred, mailId) => {
      if (starred && starLeavesCurrentView()) useAppStore.getState().setPendingRemoveIds([mailId]);
      // Invalidate all mail queries so starred state is consistent everywhere
      invalidateMailListQueries(queryClient);
    },
  });
}

export function useTogglePin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mailId: string) => togglePin(mailId),
    onSuccess: () => {
      invalidateMailListQueries(queryClient);
    },
  });
}

export function useToggleMailFlag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ mailId, flag }: { mailId: string; flag: MailFlag }) => toggleMailFlag(mailId, flag),
    onSuccess: () => {
      // Invalidate all mail queries so flag state is consistent everywhere
      invalidateMailListQueries(queryClient);
    },
  });
}

export function useRules(accountId: string | null) {
  return useQuery({
    queryKey: ["rules", accountId],
    queryFn: () => listRules(accountId!),
    enabled: !!accountId,
  });
}

export function useCreateRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (request: CreateRuleRequest) => createRule(request),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["rules", variables.account_id] });
    },
  });
}

export function useUpdateRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rule: MailRule) => updateRule(rule),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["rules", variables.account_id] });
    },
  });
}

export function useDeleteRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ ruleId, accountId }: { ruleId: string; accountId: string }) => deleteRule(ruleId),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["rules", variables.accountId] });
    },
  });
}

export function useApplyRulesNow() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (accountId: string) => applyRulesNow(accountId),
    onSuccess: (_data, accountId) => {
      queryClient.invalidateQueries({ queryKey: ["mails"] });
      queryClient.invalidateQueries({ queryKey: ["folders", accountId] });
    },
  });
}
