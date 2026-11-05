import { format, parseISO, isToday, isYesterday, isThisWeek, isThisMonth, isThisYear } from "date-fns";
import { de, enUS, es, fr, pt, ru, zhCN } from "date-fns/locale";
import type { Locale } from "date-fns";
import i18n from "./i18n";
import { weekStartsOn, type WeekDay } from "./localeDefaults";

// The date column is the most-repeated text in the app — it must follow the UI
// language, not ship as English regardless of locale.
const DATE_LOCALES: Record<string, Locale> = { de, en: enUS, es, fr, pt, ru, zh: zhCN };

// Locale-derived, not user-facing-language-derived — safe to read once at module load.
const osWeekStart = weekStartsOn();

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

// Building an Intl.DateTimeFormat costs far more than formatting with one; the list formats a date per row per render.
const listDateFormats = new Map<string, Intl.DateTimeFormat>();

function listDateFormat(kind: "monthDay" | "numeric"): Intl.DateTimeFormat {
  const key = `${i18n.language}|${kind}`;
  let formatter = listDateFormats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(
      i18n.language,
      kind === "monthDay" ? { month: "short", day: "numeric" } : { day: "2-digit", month: "2-digit", year: "2-digit" },
    );
    listDateFormats.set(key, formatter);
  }
  return formatter;
}

const shortDateTimeFormats = new Map<string, Intl.DateTimeFormat>();

export function formatShortDateTime(date: Date, use24h: boolean): string {
  if (isNaN(date.getTime())) return "";
  const withYear = !isThisYear(date);
  const key = `${i18n.language}|${use24h}|${withYear}`;
  let formatter = shortDateTimeFormats.get(key);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(i18n.language, {
      day: "numeric",
      month: "short",
      year: withYear ? "numeric" : undefined,
      hour: use24h ? "2-digit" : "numeric",
      minute: "2-digit",
      hourCycle: use24h ? "h23" : "h12",
    });
    shortDateTimeFormats.set(key, formatter);
  }
  return formatter.format(date);
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
    if (isThisYear(date)) return listDateFormat("monthDay").format(date);
    return listDateFormat("numeric").format(date);
  } catch {
    return dateStr;
  }
}

export function getDateGroup(dateStr: string, weekStart: WeekDay = osWeekStart): string {
  try {
    const date = parseISO(dateStr);
    if (isToday(date)) return "today";
    if (isYesterday(date)) return "yesterday";
    if (isThisWeek(date, { weekStartsOn: weekStart })) return "thisWeek";
    if (isThisMonth(date)) return "thisMonth";
    return "older";
  } catch {
    return "older";
  }
}
