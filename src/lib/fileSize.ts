/**
 * Human-readable byte count for attachment rows and file lists.
 *
 * Null renders as an empty string: a size the backend never recorded should
 * leave a gap in the row, not read as "0 B".
 */
export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
