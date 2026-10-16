import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { addDays, format } from "date-fns";
import { Bell, Briefcase, CalendarDays, CalendarRange, Clock } from "lucide-react";
import type { CalendarSettings } from "../../types/calendar";
import { useCalendars, useCalendarSettings, useUpdateCalendar, useUpdateCalendarSettings } from "../../hooks/useCalendar";
import { useAppStore } from "../../stores/appStore";
import { atMinutes } from "../../lib/calendar/drag";
import { weekStartsOn } from "../../lib/localeDefaults";
import { dateLocale, formatTime } from "../../lib/dateUtils";
import { Select } from "../ui/Select";
import { Skeleton } from "../ui/Skeleton";
import { alarmLabel, PRESET_MINUTES } from "./AlarmEditor";

const DURATIONS = [15, 30, 45, 60, 90, 120];
const REFERENCE_SUNDAY = new Date(2026, 0, 4);

function Section({ icon: Icon, title, hint, children }: { icon: typeof Bell; title: string; hint?: string; children: ReactNode }) {
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <Icon className="h-4 w-4 text-text-tertiary" />
        <h3 className="text-sm font-medium text-text">{title}</h3>
      </div>
      {hint && <p className="mb-3 text-xs text-text-tertiary">{hint}</p>}
      <div className={hint ? "" : "mt-2"}>{children}</div>
    </div>
  );
}

export function CalendarSettingsPanel() {
  const { t } = useTranslation();
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const { data: settings } = useCalendarSettings();
  const { data: calendars = [] } = useCalendars();
  const save = useUpdateCalendarSettings();
  const updateCalendar = useUpdateCalendar();

  if (!settings) return <Skeleton height="12rem" rounded="lg" />;

  const set = (patch: Partial<CalendarSettings>) => save.mutate({ ...settings, ...patch });
  const weekStart = weekStartsOn();
  const dayOrder = Array.from({ length: 7 }, (_, i) => (weekStart + i) % 7);
  const hourLabel = (h: number) => (h === 24 ? (use24h ? "24:00" : formatTime(atMinutes(REFERENCE_SUNDAY, 0), false)) : formatTime(atMinutes(REFERENCE_SUNDAY, h * 60), use24h));

  return (
    <div className="space-y-6">
      <Section icon={CalendarDays} title={t("calendar.settings.defaultCalendar")}>
        <Select
          value={calendars.find((c) => c.is_default)?.id ?? ""}
          options={calendars.filter((c) => !c.read_only).map((c) => ({ value: c.id, label: c.name, icon: <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} /> }))}
          onChange={(id) => updateCalendar.mutate({ id, patch: { is_default: true } })}
          ariaLabel={t("calendar.settings.defaultCalendar")}
        />
      </Section>

      <Section icon={Bell} title={t("calendar.settings.defaultReminder")} hint={t("calendar.settings.defaultReminderHint")}>
        <Select
          value={settings.default_reminder_minutes === null ? "none" : String(settings.default_reminder_minutes)}
          options={[{ value: "none", label: t("calendar.alarm.none") }, ...PRESET_MINUTES.map((m) => ({ value: String(m), label: alarmLabel(m, t) }))]}
          onChange={(v) => set({ default_reminder_minutes: v === "none" ? null : Number(v) })}
          ariaLabel={t("calendar.settings.defaultReminder")}
        />
      </Section>

      <Section icon={Clock} title={t("calendar.settings.defaultDuration")}>
        <Select
          value={String(settings.default_duration_minutes)}
          options={DURATIONS.map((m) => ({ value: String(m), label: t("calendar.settings.duration", { count: m }) }))}
          onChange={(v) => set({ default_duration_minutes: Number(v) })}
          ariaLabel={t("calendar.settings.defaultDuration")}
        />
      </Section>

      <Section icon={Briefcase} title={t("calendar.settings.workHours")} hint={t("calendar.settings.workHoursHint")}>
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-secondary">{t("calendar.settings.from")}</span>
          <div className="w-36">
            <Select
              value={String(settings.work_start_hour)}
              options={Array.from({ length: 24 }, (_, h) => ({ value: String(h), label: hourLabel(h) }))}
              onChange={(v) => {
                const start = Number(v);
                set({ work_start_hour: start, work_end_hour: Math.max(settings.work_end_hour, start + 1) });
              }}
              ariaLabel={t("calendar.settings.from")}
            />
          </div>
          <span className="text-xs text-text-secondary">{t("calendar.settings.to")}</span>
          <div className="w-36">
            <Select
              value={String(settings.work_end_hour)}
              options={Array.from({ length: 24 }, (_, i) => i + 1)
                .filter((h) => h > settings.work_start_hour)
                .map((h) => ({ value: String(h), label: hourLabel(h) }))}
              onChange={(v) => set({ work_end_hour: Number(v) })}
              ariaLabel={t("calendar.settings.to")}
            />
          </div>
        </div>
      </Section>

      <Section icon={CalendarRange} title={t("calendar.settings.workDays")}>
        <div className="flex gap-1">
          {dayOrder.map((d) => {
            const on = settings.work_days.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? settings.work_days.filter((x) => x !== d) : [...settings.work_days, d];
                  if (next.length) set({ work_days: [...next].sort((a, b) => a - b) });
                }}
                className={`h-8 w-9 rounded-lg text-xs font-medium transition-colors ${on ? "bg-accent text-white" : "bg-bg-secondary text-text-secondary hover:bg-hover"}`}
              >
                {format(addDays(REFERENCE_SUNDAY, d), "EEEEEE", { locale: dateLocale() })}
              </button>
            );
          })}
        </div>
      </Section>
    </div>
  );
}
