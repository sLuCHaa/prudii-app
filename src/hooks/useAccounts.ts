import { useQuery, useInfiniteQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { listAccounts, createAccount, deleteAccount, listFolders, listMails, listFilteredMails, listAllInboxMails, listCombinedFolderMails, listSnoozedMails, listSplitInboxMails, listInboxSplits, listAttachments, toggleStar, togglePin, toggleMailFlag, listRules, createRule, updateRule, deleteRule, applyRulesNow } from "../lib/tauri";
import type { CreateAccountRequest, CreateRuleRequest, Mail, MailFlag, MailRule } from "../types";
import type { MailFilter } from "../stores/appStore";

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

export function useMails(folderId: string | null, folderFilter?: string) {
  const filterKey = folderFilter && folderFilter !== "all" ? folderFilter : undefined;
  return useInfiniteQuery<Mail[]>({
    queryKey: ["mails", folderId, filterKey],
    queryFn: ({ pageParam = 0 }) => listMails(folderId!, PAGE_SIZE, pageParam as number, filterKey),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.flat().length,
    enabled: !!folderId,
    staleTime: 0,
  });
}

export function useFilteredMails(filter: MailFilter, accountId?: string, folderFilter?: string) {
  const filterKey = folderFilter && folderFilter !== "all" ? folderFilter : undefined;
  return useInfiniteQuery<Mail[]>({
    queryKey: ["filtered-mails", filter, accountId, filterKey],
    queryFn: ({ pageParam = 0 }) => listFilteredMails(filter!, accountId, PAGE_SIZE, pageParam as number, filterKey),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.flat().length,
    enabled: !!filter,
    staleTime: 0,
  });
}

export function useAllInboxMails(enabled: boolean, folderFilter?: string) {
  const filterKey = folderFilter && folderFilter !== "all" ? folderFilter : undefined;
  return useInfiniteQuery<Mail[]>({
    queryKey: ["all-inbox-mails", filterKey],
    queryFn: ({ pageParam = 0 }) => listAllInboxMails(PAGE_SIZE, pageParam as number, filterKey),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.flat().length,
    enabled,
    staleTime: 0,
  });
}

export function useCombinedFolderMails(folderType: string | null, folderFilter?: string) {
  const filterKey = folderFilter && folderFilter !== "all" ? folderFilter : undefined;
  return useInfiniteQuery<Mail[]>({
    queryKey: ["combined-folder-mails", folderType, filterKey],
    queryFn: ({ pageParam = 0 }) => listCombinedFolderMails(folderType!, PAGE_SIZE, pageParam as number, filterKey),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.flat().length,
    enabled: !!folderType,
    staleTime: 0,
  });
}

export function useInboxSplits() {
  return useQuery({
    queryKey: ["inbox-splits"],
    queryFn: listInboxSplits,
  });
}

export function useSplitInboxMails(splitId: string | null) {
  return useInfiniteQuery<Mail[]>({
    queryKey: ["split-inbox-mails", splitId],
    queryFn: ({ pageParam = 0 }) => listSplitInboxMails(splitId!, PAGE_SIZE, pageParam as number),
    initialPageParam: 0,
    getNextPageParam: (lastPage, allPages) =>
      lastPage.length < PAGE_SIZE ? undefined : allPages.flat().length,
    enabled: !!splitId,
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

export function useAttachments(mailId: string | null) {
  return useQuery({
    queryKey: ["attachments", mailId],
    queryFn: () => listAttachments(mailId!),
    enabled: !!mailId,
    staleTime: 0,
  });
}

export function useToggleStar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mailId: string) => toggleStar(mailId),
    onSuccess: () => {
      // Invalidate all mail queries so starred state is consistent everywhere
      queryClient.invalidateQueries({ queryKey: ["filtered-mails"] });
      queryClient.invalidateQueries({ queryKey: ["mails"] });
      queryClient.invalidateQueries({ queryKey: ["all-inbox-mails"] });
      queryClient.invalidateQueries({ queryKey: ["combined-folder-mails"] });
    },
  });
}

export function useTogglePin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mailId: string) => togglePin(mailId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["filtered-mails"] });
      queryClient.invalidateQueries({ queryKey: ["mails"] });
      queryClient.invalidateQueries({ queryKey: ["all-inbox-mails"] });
      queryClient.invalidateQueries({ queryKey: ["combined-folder-mails"] });
    },
  });
}

export function useToggleMailFlag() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ mailId, flag }: { mailId: string; flag: MailFlag }) => toggleMailFlag(mailId, flag),
    onSuccess: () => {
      // Invalidate all mail queries so flag state is consistent everywhere
      queryClient.invalidateQueries({ queryKey: ["filtered-mails"] });
      queryClient.invalidateQueries({ queryKey: ["mails"] });
      queryClient.invalidateQueries({ queryKey: ["all-inbox-mails"] });
      queryClient.invalidateQueries({ queryKey: ["combined-folder-mails"] });
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
