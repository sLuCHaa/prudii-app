export const MAIL_TEXT_SIZES = [100, 115, 130, 150] as const;

export const DEFAULT_MAIL_TEXT_SIZE = 100;

export function normalizeMailTextSize(value: unknown): number {
  return MAIL_TEXT_SIZES.find((size) => size === value) ?? DEFAULT_MAIL_TEXT_SIZE;
}

export function mailTextScale(value: unknown): number {
  return normalizeMailTextSize(value) / 100;
}
