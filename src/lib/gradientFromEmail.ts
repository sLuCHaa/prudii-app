// Deterministic email → [color1, color2] gradient mapping.
// Same sender always gets the same avatar across the app.

const GRADIENT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["#f97316", "#ec4899"],  // orange → pink
  ["#8b5cf6", "#3b82f6"],  // purple → blue
  ["#10b981", "#06b6d4"],  // emerald → cyan
  ["#f43f5e", "#f97316"],  // rose → orange
  ["#6366f1", "#8b5cf6"],  // indigo → purple
  ["#14b8a6", "#22c55e"],  // teal → green
  ["#e11d48", "#f43f5e"],  // red → rose
  ["#0ea5e9", "#6366f1"],  // sky → indigo
  ["#d946ef", "#ec4899"],  // fuchsia → pink
  ["#f59e0b", "#ef4444"],  // amber → red
  ["#06b6d4", "#3b82f6"],  // cyan → blue
  ["#84cc16", "#10b981"],  // lime → emerald
];

function hashString(str: string): number {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

export function gradientPairFromEmail(email: string): readonly [string, string] {
  const hash = hashString((email || "").toLowerCase());
  return GRADIENT_PAIRS[hash % GRADIENT_PAIRS.length];
}

export function gradientFromEmail(email: string): string {
  const [c1, c2] = gradientPairFromEmail(email);
  return `linear-gradient(135deg, ${c1}, ${c2})`;
}

export function initialsFromName(name: string, email: string): string {
  if (name && name.trim()) {
    const parts = name.trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) {
      return ((parts[0]?.[0] || "") + (parts[parts.length - 1]?.[0] || "")).toUpperCase();
    }
    if (parts.length === 1 && parts[0]) {
      return parts[0][0].toUpperCase();
    }
  }
  return email?.[0]?.toUpperCase() || "?";
}
