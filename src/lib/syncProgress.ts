import type { SyncProgress } from "../types";

type FolderCounts = Pick<SyncProgress, "folder_index" | "folder_count" | "folder_done" | "folder_total">;

export function syncPercent(p: FolderCounts): number {
  if (p.folder_count <= 0) return 0;
  const sub = p.folder_total > 0 ? Math.min(p.folder_done, p.folder_total) / p.folder_total : 0;
  return Math.min(100, ((p.folder_index + sub) / p.folder_count) * 100);
}

export interface SyncRun {
  percent: number;
  mails: number;
}

export const SYNC_RUN_START: SyncRun = { percent: 0, mails: 0 };

/** Every sync run opens with "connecting"; within a run neither bar nor count moves back. */
export function advanceSyncRun(prev: SyncRun, p: SyncProgress): SyncRun {
  if (p.status === "connecting") return SYNC_RUN_START;
  return { percent: Math.max(prev.percent, syncPercent(p)), mails: Math.max(prev.mails, p.new_mails) };
}

export function inMailPhase(p: SyncProgress | null): boolean {
  return !!p && p.folder_count > 0 && p.status !== "done" && p.status !== "error";
}

const STATUS_KEYS: Partial<Record<SyncProgress["status"], string>> = {
  connecting: "sync.connecting",
  syncing_folders: "sync.folders",
  prefetching: "sync.prefetching",
};

export function syncStatusKey(status: SyncProgress["status"]): string | null {
  return STATUS_KEYS[status] ?? null;
}

export function syncFolderLine(p: SyncProgress): string | null {
  if (!p.folder_name || p.folder_count <= 0) return null;
  const line = `${p.folder_name} (${Math.min(p.folder_index + 1, p.folder_count)}/${p.folder_count})`;
  if (p.folder_total <= 0) return line;
  return `${line} — ${Math.min(p.folder_done, p.folder_total).toLocaleString()} / ${p.folder_total.toLocaleString()}`;
}
