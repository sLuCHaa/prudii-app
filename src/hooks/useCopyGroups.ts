import { useQueries } from "@tanstack/react-query";
import { useAppStore } from "../stores/appStore";
import { listFolders } from "../lib/tauri";
import { copyTargets, takesImapUpload, type CopyGroup } from "../lib/moveTargets";

/** The folders of the other accounts a mail from `sourceAccountId` can be copied into. */
export function useCopyGroups(sourceAccountId: string | null): CopyGroup[] {
  const accounts = useAppStore((s) => s.accounts);
  const others = sourceAccountId ? accounts.filter((a) => a.id !== sourceAccountId && takesImapUpload(a)) : [];
  const queries = useQueries({
    queries: others.map((a) => ({ queryKey: ["folders", a.id], queryFn: () => listFolders(a.id) })),
  });
  return copyTargets(accounts, sourceAccountId, (id) => queries[others.findIndex((a) => a.id === id)]?.data ?? []);
}
