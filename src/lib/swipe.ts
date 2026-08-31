// Trackpad swipe on mail rows. Wheel deltas are positive when scrolling
// right; the row moves WITH the fingers, so the offset is the negated sum.
export const SWIPE_TRIGGER_PX = 96;
export const SWIPE_MAX_PX = 128;

export function accumulate(current: number, deltaX: number): number {
  const next = current - deltaX;
  return Math.max(-SWIPE_MAX_PX, Math.min(SWIPE_MAX_PX, next));
}

export function decide(offset: number): "archive" | "trash" | null {
  if (offset >= SWIPE_TRIGGER_PX) return "archive";
  if (offset <= -SWIPE_TRIGGER_PX) return "trash";
  return null;
}

export function isHorizontalIntent(deltaX: number, deltaY: number): boolean {
  return Math.abs(deltaX) > 4 && Math.abs(deltaX) > Math.abs(deltaY) * 1.5;
}
