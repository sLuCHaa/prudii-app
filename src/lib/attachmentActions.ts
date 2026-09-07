export { revealAttachment } from "./tauri";

export type RevealLabelKey = "attachments.reveal.finder" | "attachments.reveal.explorer" | "attachments.reveal.fileManager";

export function revealLabelKey(p: { isMac: boolean; isWindows: boolean }): RevealLabelKey {
  if (p.isMac) return "attachments.reveal.finder";
  if (p.isWindows) return "attachments.reveal.explorer";
  return "attachments.reveal.fileManager";
}
