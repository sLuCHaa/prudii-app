export interface Rect { x: number; y: number; width: number; height: number }

const PROBE = 40; // a title-bar-sized corner must be visible to count as "on screen"

export function pickComposePosition(
  saved: { x: number; y: number } | null,
  monitors: Rect[],
  cascadeOffset: number,
  size: { w: number; h: number },
): { x: number; y: number } | null {
  if (!saved) return null;
  const px = saved.x + PROBE;
  const py = saved.y + PROBE;
  const m = monitors.find((r) => px >= r.x && px < r.x + r.width && py >= r.y && py < r.y + r.height);
  if (!m) return null;
  const x = Math.min(Math.max(saved.x + cascadeOffset, m.x), m.x + m.width - size.w);
  const y = Math.min(Math.max(saved.y + cascadeOffset, m.y), m.y + m.height - size.h);
  return { x: Math.round(x), y: Math.round(y) };
}
