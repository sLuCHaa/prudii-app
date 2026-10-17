import { useRef } from "react";
import type { SyncProgress } from "../types";
import { advanceSyncRun, SYNC_RUN_START, type SyncRun } from "../lib/syncProgress";

export function useSyncRun(progress: SyncProgress | null): SyncRun {
  const run = useRef(SYNC_RUN_START);
  if (progress) run.current = advanceSyncRun(run.current, progress);
  return run.current;
}
