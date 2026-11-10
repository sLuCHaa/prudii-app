import type { Folder } from "../types";

export type SidebarFolds = Record<string, boolean>;

export const SIDEBAR_FOLDS_KEY = "prudii-sidebar-folds";

export const categoriesFoldKey = (accountId: string | null) => `categories:${accountId ?? "all"}`;
export const ownFoldersFoldKey = (accountId: string) => `folders:${accountId}`;

export function isFoldOpen(folds: SidebarFolds, key: string, openByDefault: boolean): boolean {
  return folds[key] ?? openByDefault;
}

export function toggleFold(folds: SidebarFolds, key: string, openByDefault: boolean): SidebarFolds {
  return { ...folds, [key]: !isFoldOpen(folds, key, openByDefault) };
}

export function readFolds(raw: string | null): SidebarFolds {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw ?? "{}");
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  return Object.fromEntries(Object.entries(parsed).filter(([, open]) => typeof open === "boolean")) as SidebarFolds;
}

/** With several accounts the all-inboxes row already lists the categories; each account repeating them is the clutter. */
export function accountCategoriesStartOpen(accountCount: number): boolean {
  return accountCount < 2;
}

export function splitFolders(folders: Folder[]): { standard: Folder[]; own: Folder[] } {
  return {
    standard: folders.filter((f) => f.folder_type !== "custom"),
    own: folders.filter((f) => f.folder_type === "custom"),
  };
}
