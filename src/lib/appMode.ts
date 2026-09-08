export type AppMode = "main" | "compose" | "backup";

/**
 * Secondary windows are told apart by the query string Rust/JS puts on their
 * URL — the window label is not available synchronously at first render.
 */
export function resolveAppMode(search: string): AppMode {
  const params = new URLSearchParams(search);
  if (params.has("compose")) return "compose";
  if (params.has("backup")) return "backup";
  return "main";
}
