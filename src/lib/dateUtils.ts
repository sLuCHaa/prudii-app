import { format, parseISO, isToday, isYesterday, isThisWeek, isThisMonth } from "date-fns";

export function formatTime(date: Date, use24h: boolean): string {
  if (!date || isNaN(date.getTime())) return "";
  return use24h ? format(date, "HH:mm") : format(date, "h:mm a");
}

export function formatDateTime(date: Date, use24h: boolean): string {
  if (!date || isNaN(date.getTime())) return "";
  const timeFormat = use24h ? "HH:mm" : "h:mm a";
  return format(date, `MMM d, yyyy 'at' ${timeFormat}`);
}

/**
 * Format date for mail list - shows time for today, "Yesterday" for yesterday, date for older
 */
export function formatMailDate(dateStr: string, use24h: boolean, yesterdayLabel = "Yesterday"): string {
  try {
    const date = parseISO(dateStr);
    if (isToday(date)) return formatTime(date, use24h);
    if (isYesterday(date)) return yesterdayLabel;
    return format(date, "MMM d");
  } catch {
    return dateStr;
  }
}

export function getDateGroup(dateStr: string): string {
  try {
    const date = parseISO(dateStr);
    if (isToday(date)) return "today";
    if (isYesterday(date)) return "yesterday";
    if (isThisWeek(date, { weekStartsOn: 1 })) return "thisWeek";
    if (isThisMonth(date)) return "thisMonth";
    return "older";
  } catch {
    return "older";
  }
}
