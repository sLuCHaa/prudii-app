import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";

export type { Update };

export type UpdateProgress =
  | { phase: "downloading"; pct: number }
  | { phase: "verifying" }
  | { phase: "ready" };

/** Check GitHub's latest.json for a newer signed release. */
export async function checkForUpdate(): Promise<Update | null> {
  return (await check()) ?? null;
}

/**
 * Download + signature-verify + install the update, reporting progress, then
 * relaunch. The plugin verifies the minisign signature internally and throws
 * if it fails.
 */
export async function installUpdate(
  update: Update,
  onProgress: (p: UpdateProgress) => void,
): Promise<void> {
  let total = 0;
  let downloaded = 0;
  await update.downloadAndInstall((event) => {
    switch (event.event) {
      case "Started":
        total = event.data.contentLength ?? 0;
        onProgress({ phase: "downloading", pct: 0 });
        break;
      case "Progress":
        downloaded += event.data.chunkLength;
        onProgress({
          phase: "downloading",
          pct: total > 0 ? Math.min(100, Math.round((downloaded / total) * 100)) : 0,
        });
        break;
      case "Finished":
        onProgress({ phase: "verifying" });
        break;
    }
  });
  onProgress({ phase: "ready" });
  await relaunch();
}
