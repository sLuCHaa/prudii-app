import type { TFunction } from "i18next";
import type { CategoryReason } from "../types";

export const BUILTIN_CATEGORIES = ["important", "purchases", "notifications", "newsletters", "promotions", "social"] as const;

export type CategoryId = (typeof BUILTIN_CATEGORIES)[number];

export const CATEGORY_COLORS: Record<CategoryId, string> = {
  important: "#d9573f",
  purchases: "#3aa86b",
  notifications: "#5a73d6",
  newsletters: "#9b5bd1",
  promotions: "#d99a2b",
  social: "#2b97ab",
};

export function isCategoryId(v: string | null | undefined): v is CategoryId {
  return !!v && (BUILTIN_CATEGORIES as readonly string[]).includes(v);
}

export function visibleCategories(hidden: readonly string[]): CategoryId[] {
  return BUILTIN_CATEGORIES.filter((c) => !hidden.includes(c));
}

export function shownCategory(category: string | null, hidden: readonly string[]): CategoryId | null {
  return isCategoryId(category) && !hidden.includes(category) ? category : null;
}

export function reasonText(t: TFunction, reason: CategoryReason): string {
  const key = `categories.reasons.${reason.code}`;
  if (reason.params.count !== undefined) {
    return t(key, { ...reason.params, count: Number(reason.params.count) });
  }
  return t(key, reason.params);
}
