const CLEANUP_FOLDER_TYPES = new Set(["spam", "trash"]);

export function isCleanupFolder(folderType: string): boolean {
  return CLEANUP_FOLDER_TYPES.has(folderType);
}

/** Mails still lying in Spam or Trash, as shown in the sidebar; 0 hides the badge. */
export function cleanupCount(
  folder: { folder_type: string; total_count: number },
  enabled: boolean,
): number {
  if (!enabled || !isCleanupFolder(folder.folder_type)) return 0;
  return Math.max(0, folder.total_count);
}

export function formatCleanupCount(count: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(count);
}
