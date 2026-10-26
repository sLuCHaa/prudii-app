export type ViewKind = "image" | "pdf" | "file";

const SHOWABLE_IMAGES = new Set([
  "image/png", "image/jpeg", "image/jpg", "image/gif", "image/webp", "image/bmp", "image/avif", "image/svg+xml",
]);

export function viewKind(type: string, name: string): ViewKind {
  const mime = type.toLowerCase();
  if (SHOWABLE_IMAGES.has(mime)) return "image";
  if (mime === "application/pdf" || name.toLowerCase().endsWith(".pdf")) return "pdf";
  return "file";
}

export function viewableOfKind<T extends { type: string; name: string; status: string }>(attachments: T[], kind: ViewKind): T[] {
  return attachments.filter((a) => a.status === "ready" && viewKind(a.type, a.name) === kind);
}
