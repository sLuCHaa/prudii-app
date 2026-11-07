import { useMutation, useQuery } from "@tanstack/react-query";
import { syncAccount, syncAllAccounts, syncAutomaticAccounts, searchMails, searchMailsRemote } from "../lib/tauri";
import { mergeSearchResults } from "../lib/searchMerge";
import { useAccounts } from "./useAccounts";
import { useState, useEffect, useMemo } from "react";

export function useSyncAccount() {
  return useMutation({
    mutationFn: (params: { accountId: string; password?: string } | string) => {
      const accountId = typeof params === "string" ? params : params.accountId;
      const password = typeof params === "string" ? undefined : params.password;
      return syncAccount(accountId, password);
    },
    // No onSuccess — queries are invalidated by the global "done" event listener in App.tsx
  });
}

export function useSyncAll() {
  return useMutation({
    mutationFn: () => syncAllAccounts(),
  });
}

export function useSyncAutomatic() {
  return useMutation({
    mutationFn: () => syncAutomaticAccounts(),
  });
}

/**
 * Local full-text hits right away, plus what Gmail's and Outlook's own search
 * finds in mails whose text was never downloaded.
 */
export function useSearchMails(query: string, accountId?: string) {
  const [debouncedQuery, setDebouncedQuery] = useState(query);
  const [serverQuery, setServerQuery] = useState(query);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  // The provider is asked only once typing settles: every request counts
  // against the account's API quota.
  useEffect(() => {
    const timer = setTimeout(() => setServerQuery(query), 800);
    return () => clearTimeout(timer);
  }, [query]);

  const local = useQuery({
    queryKey: ["search", debouncedQuery, accountId],
    queryFn: () => searchMails(debouncedQuery, accountId),
    enabled: debouncedQuery.length >= 2,
  });

  // Only Gmail and Outlook signed in through their API keep bodies off the
  // device; IMAP accounts have every text in the local index already.
  const { data: accounts } = useAccounts();
  const hasServerSearch = (accounts ?? []).some(
    (a) =>
      a.auth_type === "oauth" &&
      (a.provider === "google" || a.provider === "microsoft") &&
      (!accountId || a.id === accountId),
  );

  const serverTerm = serverQuery.trim();
  const server = useQuery({
    queryKey: ["search-server", serverTerm, accountId],
    queryFn: () => searchMailsRemote(serverTerm, accountId),
    enabled: hasServerSearch && serverTerm.length >= 3,
    retry: false,
  });

  const serverHits = serverQuery === debouncedQuery ? server.data : undefined;
  const data = useMemo(() => mergeSearchResults(local.data, serverHits), [local.data, serverHits]);

  return { data, isLoading: local.isLoading, isSearchingServer: server.isFetching };
}
