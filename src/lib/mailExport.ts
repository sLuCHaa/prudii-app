import type { TFunction } from "i18next";
import type { ExportLabels, ExportSummary, Folder, FolderType } from "../types";

const FOLDER_TYPES: FolderType[] = ["inbox", "sent", "drafts", "trash", "spam", "archive"];

export function defaultFolderIds(folders: Folder[]): string[] {
  return folders.filter((f) => f.folder_type !== "trash" && f.folder_type !== "spam").map((f) => f.id);
}

export function exportNeedsAttention(summary: ExportSummary): boolean {
  return summary.failed > 0 || summary.cancelled;
}

export function exportResultTitle(t: TFunction, summary: ExportSummary): string {
  return t(summary.cancelled ? "mailExport.cancelledTitle" : "mailExport.doneTitle");
}

export function exportResultMessage(t: TFunction, summary: ExportSummary): string {
  const parts = [t("mailExport.doneMessage", { exported: summary.exported + summary.localCopy })];
  if (summary.localCopy > 0) parts.push(t("mailExport.doneLocal", { count: summary.localCopy }));
  if (summary.failed > 0) parts.push(t("mailExport.doneFailed", { count: summary.failed }));
  return parts.join(" ");
}

export function buildExportLabels(t: TFunction, lang: string): ExportLabels {
  // The exported page fills {count} itself, so i18next must leave it alone.
  const raw = (key: string) => t(key, { interpolation: { skipOnVariables: true } }) as string;
  const folderNames: Record<string, string> = {};
  for (const type of FOLDER_TYPES) folderNames[type] = t(`folder.types.${type}`);
  return {
    lang,
    title: raw("mailExport.page.title"),
    searchPlaceholder: raw("mailExport.page.search"),
    back: raw("mailExport.page.back"),
    to: raw("mailExport.page.to"),
    cc: raw("mailExport.page.cc"),
    noSubject: raw("mailExport.page.noSubject"),
    attachments: raw("mailExport.page.attachments"),
    externalImagesNote: raw("mailExport.page.externalImages"),
    localCopyNote: raw("mailExport.page.localCopyNote"),
    localCopyTitle: raw("mailExport.page.localCopyTitle"),
    failedTitle: raw("mailExport.page.failedTitle"),
    incompleteNote: raw("mailExport.page.incomplete"),
    accountsOne: raw("mailExport.page.accounts_one"),
    accountsOther: raw("mailExport.page.accounts_other"),
    mailsOne: raw("mailExport.page.mails_one"),
    mailsOther: raw("mailExport.page.mails_other"),
    emptyFolder: raw("mailExport.page.emptyFolder"),
    noResults: raw("mailExport.page.noResults"),
    folderNames,
  };
}
