/** Parse "X of Y message(s)" sub-folder progress from a backend sync message.
 *  Insert-phase messages round X up to the batch size, so X is clamped to Y. */
export function parseSyncSubProgress(message: string): { current: number; total: number } {
  const m = message.match(/(\d+)\s+(?:of|von)\s+(\d+)\s+message/i);
  if (!m) return { current: 0, total: 0 };
  const total = parseInt(m[2], 10);
  return { current: Math.min(parseInt(m[1], 10), total), total };
}
