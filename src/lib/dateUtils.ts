import { format, parseISO, isToday, isYesterday, isThisWeek, isThisMonth } from "date-fns";
import { de, enUS, es, fr, pt, ru, zhCN } from "date-fns/locale";
import type { Locale } from "date-fns";
import i18n from "./i18n";

// The date column is the most-repeated text in the app — it must follow the UI
// language, not ship as English regardless of locale.
const DATE_LOCALES: Record<string, Locale> = { de, en: enUS, es, fr, pt, ru, zh: zhCN };

export function dateLocale(): Locale {
  const lang = (i18n.language || "en").split("-")[0];
  return DATE_LOCALES[lang] ?? enUS;
}

export function formatTime(date: Date, use24h: boolean): string {
  if (!date || isNaN(date.getTime())) return "";
  return format(date, use24h ? "HH:mm" : "h:mm a", { locale: dateLocale() });
}

export function formatDateTime(date: Date, use24h: boolean): string {
  if (!date || isNaN(date.getTime())) return "";
  const timeFormat = use24h ? "HH:mm" : "h:mm a";
  // PPP renders the long date in the locale's own order ("29. März 2026" vs
  // "March 29th, 2026") — no hardcoded English 'at' connector.
  return format(date, `PPP, ${timeFormat}`, { locale: dateLocale() });
}

/**
 * Format date for mail list - shows time for today, "Yesterday" for yesterday, date for older
 */
export function formatMailDate(dateStr: string, use24h: boolean): string {
  try {
    const date = parseISO(dateStr);
    if (isToday(date)) return formatTime(date, use24h);
    if (isYesterday(date)) return i18n.t("dateGroups.yesterday");
    // Intl orders day/month per locale ("Mar 12" vs "12. März")
    return new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric" }).format(date);
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
