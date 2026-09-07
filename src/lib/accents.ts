import type { AccentColor } from "../types";

export interface AccentOption {
  id: AccentColor;
  hex: string | null;
  labelKey: string;
}

export const DEFAULT_ACCENT_HEX = "#3b82f6";

// Single source for the settings swatches, the command palette and the badge.
export const ACCENT_OPTIONS: readonly AccentOption[] = [
  { id: "blue", hex: "#3b82f6", labelKey: "commandPalette.accentBlue" },
  { id: "purple", hex: "#8b5cf6", labelKey: "commandPalette.accentPurple" },
  { id: "green", hex: "#10b981", labelKey: "commandPalette.accentGreen" },
  { id: "teal", hex: "#14b8a6", labelKey: "commandPalette.accentTeal" },
  { id: "orange", hex: "#f97316", labelKey: "commandPalette.accentOrange" },
  { id: "pink", hex: "#ec4899", labelKey: "commandPalette.accentPink" },
  { id: "red", hex: "#ef4444", labelKey: "commandPalette.accentRed" },
  { id: "amber", hex: "#f59e0b", labelKey: "commandPalette.accentAmber" },
  { id: "system", hex: null, labelKey: "commandPalette.accentSystem" },
];

export function isAccentHex(s: unknown): s is string {
  return typeof s === "string" && /^#[0-9a-fA-F]{6}$/.test(s);
}

export function effectiveAccentHex(accent: AccentColor, systemHex: string | null): string {
  if (accent === "system") return isAccentHex(systemHex) ? systemHex : DEFAULT_ACCENT_HEX;
  return ACCENT_OPTIONS.find((o) => o.id === accent)?.hex ?? DEFAULT_ACCENT_HEX;
}
