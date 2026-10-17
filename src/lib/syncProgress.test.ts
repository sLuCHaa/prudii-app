import { describe, it, expect } from "vitest";
import type { SyncProgress } from "../types";
import { syncPercent, advanceSyncRun, SYNC_RUN_START, inMailPhase, syncFolderLine, syncStatusKey } from "./syncProgress";

function progress(over: Partial<SyncProgress> = {}): SyncProgress {
  return {
    account_id: "a",
    status: "syncing_mails",
    folder_name: "Inbox",
    folder_index: 0,
    folder_count: 4,
    folder_done: 0,
    folder_total: 0,
    new_mails: 0,
    message: "",
    ...over,
  };
}

describe("syncPercent", () => {
  it("adds the share of the current folder to the finished folders", () => {
    expect(syncPercent(progress({ folder_index: 1, folder_done: 250, folder_total: 500 }))).toBe(37.5);
  });

  it("ignores the message text", () => {
    expect(syncPercent(progress({ message: "Syncing Inbox — 400 of 500 messages..." }))).toBe(0);
  });

  it("is zero before any folder is known", () => {
    expect(syncPercent(progress({ folder_count: 0, folder_done: 5, folder_total: 10 }))).toBe(0);
  });

  it("clamps an overshooting folder count to the folder end", () => {
    expect(syncPercent(progress({ folder_index: 3, folder_done: 900, folder_total: 500 }))).toBe(100);
  });
});

describe("advanceSyncRun", () => {
  it("never moves the bar back within a sync run", () => {
    const half = advanceSyncRun(SYNC_RUN_START, progress({ folder_index: 1, folder_done: 400, folder_total: 400 }));
    expect(advanceSyncRun(half, progress({ folder_index: 1 })).percent).toBe(50);
  });

  it("keeps mails a failed folder already stored in the count", () => {
    const partial = advanceSyncRun(SYNC_RUN_START, progress({ new_mails: 1500 }));
    expect(advanceSyncRun(partial, progress({ status: "folder_error", new_mails: 0 })).mails).toBe(1500);
  });

  it("starts over when a new run connects", () => {
    const run = { percent: 80, mails: 900 };
    expect(advanceSyncRun(run, progress({ status: "connecting", folder_count: 0 }))).toEqual(SYNC_RUN_START);
  });
});

describe("inMailPhase", () => {
  it("is false while connecting and listing folders", () => {
    expect(inMailPhase(progress({ status: "connecting", folder_count: 0 }))).toBe(false);
    expect(inMailPhase(progress({ status: "syncing_folders", folder_count: 0 }))).toBe(false);
  });

  it("stays true through folder errors and the prefetch", () => {
    expect(inMailPhase(progress({ status: "syncing_mails" }))).toBe(true);
    expect(inMailPhase(progress({ status: "folder_error" }))).toBe(true);
    expect(inMailPhase(progress({ status: "prefetching", folder_index: 4 }))).toBe(true);
  });

  it("ends with done or error", () => {
    expect(inMailPhase(progress({ status: "done" }))).toBe(false);
    expect(inMailPhase(progress({ status: "error" }))).toBe(false);
    expect(inMailPhase(null)).toBe(false);
  });
});

describe("syncFolderLine", () => {
  it("names the folder, its position and the count inside it", () => {
    expect(syncFolderLine(progress({ folder_index: 1, folder_done: 150, folder_total: 500 }))).toBe("Inbox (2/4) — 150 / 500");
  });

  it("leaves the count out while the folder size is unknown", () => {
    expect(syncFolderLine(progress())).toBe("Inbox (1/4)");
  });

  it("keeps the position inside the folder count after the last folder", () => {
    expect(syncFolderLine(progress({ folder_index: 4 }))).toBe("Inbox (4/4)");
  });

  it("is null without a folder", () => {
    expect(syncFolderLine(progress({ folder_name: null }))).toBeNull();
  });
});

describe("syncStatusKey", () => {
  it("names the phases that have no folder line", () => {
    expect(syncStatusKey("connecting")).toBe("sync.connecting");
    expect(syncStatusKey("syncing_folders")).toBe("sync.folders");
    expect(syncStatusKey("prefetching")).toBe("sync.prefetching");
  });

  it("is null while folders are synced", () => {
    expect(syncStatusKey("syncing_mails")).toBeNull();
    expect(syncStatusKey("folder_error")).toBeNull();
  });
});
