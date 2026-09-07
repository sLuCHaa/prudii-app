import { revealItemInDir } from "@tauri-apps/plugin-opener";

export type RevealLabelKey = "attachments.reveal.finder" | "attachments.reveal.explorer" | "attachments.reveal.fileManager";

export function revealLabelKey(p: { isMac: boolean; isWindows: boolean }): RevealLabelKey {
  if (p.isMac) return "attachments.reveal.finder";
  if (p.isWindows) return "attachments.reveal.explorer";
  return "attachments.reveal.fileManager";
}

export async function revealAttachment(localPath: string | null): Promise<void> {
  if (!localPath) return;
  await revealItemInDir(localPath);
}
