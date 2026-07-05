import { useMutation, useQuery } from "@tanstack/react-query";
import { syncAccount, syncAllAccounts, searchMails } from "../lib/tauri";
import { useState, useEffect } from "react";

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

export function useSearchMails(query: string, accountId?: string) {
  const [debouncedQuery, setDebouncedQuery] = useState(query);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 300);
    return () => clearTimeout(timer);
  }, [query]);

  return useQuery({
    queryKey: ["search", debouncedQuery, accountId],
    queryFn: () => searchMails(debouncedQuery, accountId),
    enabled: debouncedQuery.length >= 2,
  });
}
