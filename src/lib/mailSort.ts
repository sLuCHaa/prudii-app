export type MailSortField = "date" | "correspondent" | "subject";
export type MailSortDirection = "asc" | "desc";
export type MailSort = `${MailSortField}_${MailSortDirection}`;

export const DEFAULT_MAIL_SORT: MailSort = "date_desc";
export const MAIL_SORT_FIELDS: MailSortField[] = ["date", "correspondent", "subject"];

export function parseMailSort(value?: string | null): MailSort {
  const [field, direction] = (value ?? "").split("_");
  if (MAIL_SORT_FIELDS.includes(field as MailSortField) && (direction === "asc" || direction === "desc")) {
    return `${field as MailSortField}_${direction}`;
  }
  return DEFAULT_MAIL_SORT;
}

export function sortField(sort: MailSort): MailSortField {
  return sort.split("_")[0] as MailSortField;
}

export function sortDirection(sort: MailSort): MailSortDirection {
  return sort.split("_")[1] as MailSortDirection;
}

export function nextSort(current: MailSort, field: MailSortField): MailSort {
  if (sortField(current) === field) return `${field}_${sortDirection(current) === "asc" ? "desc" : "asc"}`;
  return field === "date" ? "date_desc" : `${field}_asc`;
}

export function isDateSort(sort: MailSort): boolean {
  return sortField(sort) === "date";
}

/** Only newest-first loads the open mail's neighbourhood first; elsewhere it may just sit on a later page. */
export function absenceMeansMoved(sort: MailSort): boolean {
  return sort === "date_desc";
}
