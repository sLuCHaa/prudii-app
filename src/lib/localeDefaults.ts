export type WeekDay = 0 | 1 | 2 | 3 | 4 | 5 | 6;

// Regional conventions follow the OS locale, not the UI language: a German
// speaker on a US system still expects that machine's clock and calendar.
// hourCycle is ECMA-402 (ES2021 Intl) but the project's lib target is ES2020.
type ResolvedOptionsWithHourCycle = Intl.ResolvedDateTimeFormatOptions & { hourCycle?: string };

export function prefers24HourClock(locale: string = navigator.language): boolean {
  try {
    const options = new Intl.DateTimeFormat(locale, { hour: "numeric" })
      .resolvedOptions() as ResolvedOptionsWithHourCycle;
    return options.hourCycle === "h23" || options.hourCycle === "h24";
  } catch {
    return true;
  }
}

interface WeekInfoLocale extends Intl.Locale {
  getWeekInfo?: () => { firstDay: number };
  weekInfo?: { firstDay: number };
}

// Intl numbers days 1 (Monday) … 7 (Sunday); date-fns wants 0 (Sunday) … 6.
export function weekStartsOn(locale: string = navigator.language): WeekDay {
  try {
    const l = new Intl.Locale(locale) as WeekInfoLocale;
    const info = l.getWeekInfo?.() ?? l.weekInfo;
    if (info) return (info.firstDay % 7) as WeekDay;
  } catch {
    // invalid locale tag — fall through
  }
  return 1;
}
