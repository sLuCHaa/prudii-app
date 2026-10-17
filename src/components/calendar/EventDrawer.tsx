import { useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { addDays, differenceInCalendarDays, format } from "date-fns";
import { AlignLeft, Bell, CalendarDays, Clock, MapPin, Repeat, Trash2, Users, Video, X } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { EditScope, EventDetail, EventEditorTarget, EventPatch, EventTimes, Occurrence } from "../../types/calendar";
import { listOccurrences } from "../../lib/tauri";
import { calendarErrorToast, useCalendars, useCalendarSettings, useCreateEvent, useEvent, useUpdateEvent } from "../../hooks/useCalendar";
import { isoDate, parseIsoDate } from "../../lib/calendar/dates";
import { detectPreset, presetRrule } from "../../lib/calendar/rrule";
import { findMeetingLink } from "../../lib/calendar/meetingLinks";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { DateField } from "../ui/DateField";
import { Select } from "../ui/Select";
import { Skeleton } from "../ui/Skeleton";
import { TimeField } from "../ui/TimeField";
import { SPRING_SNAPPY, TRANSITION_INSTANT } from "../motion/tokens";
import { AlarmEditor } from "./AlarmEditor";
import { RecurrenceEditor } from "./RecurrenceEditor";
import { EventReadOnlyBody } from "./EventReadOnlyBody";
import { useEventActions } from "./useEventActions";
import { Button } from "../ui/Button";

const INPUT = "h-9 px-3 rounded-control inset-shadow-field border border-border bg-bg-secondary text-sm text-text outline-none focus:border-accent";
const START_DERIVED = ["weekly", "monthlyDay", "monthlyNth"];

interface FormState {
  title: string;
  allDay: boolean;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  rrule: string | null;
  calendarId: string;
  location: string;
  description: string;
  alarms: number[];
}

const timeOf = (d: Date) => format(d, "HH:mm");

function atLocal(date: string, time: string): Date {
  const d = parseIsoDate(date);
  const [h, m] = time.split(":").map(Number);
  d.setHours(h || 0, m || 0, 0, 0);
  return d;
}

/** All-day ends are shown inclusive in the form and stored exclusive. */
function formTimes(times: EventTimes): Pick<FormState, "allDay" | "startDate" | "startTime" | "endDate" | "endTime"> {
  if (times.all_day) {
    const last = addDays(parseIsoDate(times.end), -1);
    const endDate = last < parseIsoDate(times.start) ? times.start : isoDate(last);
    return { allDay: true, startDate: times.start, startTime: "09:00", endDate, endTime: "10:00" };
  }
  const s = new Date(times.start);
  const e = new Date(times.end);
  return { allDay: false, startDate: isoDate(s), startTime: timeOf(s), endDate: isoDate(e), endTime: timeOf(e) };
}

function toTimes(f: FormState): EventTimes {
  if (f.allDay) return { all_day: true, start: f.startDate, end: isoDate(addDays(parseIsoDate(f.endDate), 1)) };
  return { all_day: false, start: atLocal(f.startDate, f.startTime).toISOString(), end: atLocal(f.endDate, f.endTime).toISOString() };
}

function timesValid(f: FormState): boolean {
  return f.allDay ? f.endDate >= f.startDate : atLocal(f.endDate, f.endTime) > atLocal(f.startDate, f.startTime);
}

/** The slot being edited: handed over by the view, or looked up around its key. */
function useTargetOccurrence(target: EventEditorTarget, detail: EventDetail | undefined) {
  const given = target.mode === "edit" ? target.occurrence ?? null : null;
  const eventId = target.mode === "edit" ? target.eventId : "";
  const key = target.mode === "edit" ? target.occurrenceKey ?? detail?.event.dtstart ?? null : null;
  const day = key ? parseIsoDate(key.slice(0, 10)) : null;
  const calendarId = detail?.event.calendar_id;
  const { data: around, isFetched } = useQuery({
    queryKey: ["occurrences", "slot", eventId, key],
    queryFn: () => listOccurrences(addDays(day!, -1).toISOString(), addDays(day!, 2).toISOString(), [calendarId!]),
    enabled: !given && !!day && !!calendarId,
  });
  if (given) return { occurrence: given as Occurrence | null, missing: false };
  const match = around?.find((o) => o.event_id === eventId && o.occurrence_key === key) ?? null;
  return { occurrence: match, missing: isFetched && !match };
}

function Field({ icon: Icon, label, children }: { icon: typeof Clock; label?: string; children: ReactNode }) {
  return (
    <div className="flex gap-3">
      <Icon className="mt-1 h-4 w-4 shrink-0 text-text-tertiary" />
      <div className="min-w-0 flex-1">
        {label && <div className="mb-1.5 text-xs font-medium text-text-secondary">{label}</div>}
        {children}
      </div>
    </div>
  );
}

interface EventDrawerProps {
  target: EventEditorTarget;
  onClose: () => void;
}

export function EventDrawer({ target, onClose }: EventDrawerProps) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();
  const ref = useFocusTrap<HTMLElement>(true);
  const { data: calendars = [] } = useCalendars();
  const { data: settings } = useCalendarSettings();
  const { data: detail } = useEvent(target.mode === "edit" ? target.eventId : null);
  const { occurrence, missing } = useTargetOccurrence(target, detail);
  const create = useCreateEvent();
  const update = useUpdateEvent();
  const actions = useEventActions();
  const readOnly = target.mode === "edit" && !!detail?.read_only;
  const [form, setForm] = useState<FormState | null>(null);
  const initial = useRef<FormState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (form) return;
    let next: FormState | null = null;
    if (target.mode === "new") {
      const calendarId =
        target.draft.calendarId ?? calendars.find((c) => c.is_default && !c.read_only)?.id ?? calendars.find((c) => !c.read_only)?.id;
      if (!calendarId || !settings) return;
      const times = target.draft.times;
      next = {
        title: target.draft.title ?? "",
        ...formTimes(times),
        rrule: null,
        calendarId,
        location: target.draft.location ?? "",
        description: target.draft.description ?? "",
        alarms: !times.all_day && settings.default_reminder_minutes !== null ? [settings.default_reminder_minutes] : [],
      };
    } else if (detail && occurrence) {
      next = {
        title: detail.event.title,
        ...formTimes({ all_day: occurrence.all_day, start: occurrence.start, end: occurrence.end }),
        rrule: detail.event.rrule,
        calendarId: detail.event.calendar_id,
        location: detail.event.location,
        description: detail.event.description,
        alarms: detail.alarms,
      };
    }
    if (next) {
      initial.current = next;
      setForm(next);
    }
  }, [form, target, calendars, settings, detail, occurrence]);

  useEffect(() => {
    if (!missing || form) return;
    calendarErrorToast(new Error("calendar.errors.notFound"));
    onClose();
  }, [missing, form, onClose]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void save();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const patchForm = (patch: Partial<FormState>) => {
    setError(null);
    setForm((f) => (f ? { ...f, ...patch } : f));
  };

  function changeStartDate(date: string) {
    setError(null);
    setForm((f) => {
      if (!f) return f;
      const oldStart = parseIsoDate(f.startDate);
      const newStart = parseIsoDate(date);
      const shift = differenceInCalendarDays(newStart, oldStart);
      const preset = detectPreset(f.rrule, oldStart);
      const rrule = target.mode === "new" && START_DERIVED.includes(preset) ? presetRrule(preset, newStart) : f.rrule;
      return { ...f, startDate: date, endDate: isoDate(addDays(parseIsoDate(f.endDate), shift)), rrule };
    });
  }

  function changeStartTime(time: string) {
    setError(null);
    setForm((f) => {
      if (!f) return f;
      const length = Math.max(0, atLocal(f.endDate, f.endTime).getTime() - atLocal(f.startDate, f.startTime).getTime());
      const end = new Date(atLocal(f.startDate, time).getTime() + length);
      return { ...f, startTime: time, endDate: isoDate(end), endTime: timeOf(end) };
    });
  }

  function toggleAllDay(allDay: boolean) {
    setError(null);
    setForm((f) => {
      if (!f) return f;
      if (allDay) return { ...f, allDay, endDate: f.endDate < f.startDate ? f.startDate : f.endDate };
      return { ...f, allDay, startTime: "09:00", endTime: f.endDate === f.startDate ? "10:00" : f.endTime };
    });
  }

  async function save() {
    if (!form || saving || readOnly) return;
    if (!timesValid(form)) {
      setError(t("calendar.drawer.endBeforeStart"));
      return;
    }
    setSaving(true);
    try {
      if (target.mode === "new") {
        await create.mutateAsync({
          calendar_id: form.calendarId,
          title: form.title,
          description: form.description,
          location: form.location,
          times: toTimes(form),
          rrule: form.rrule,
          alarms: form.alarms,
        });
        onClose();
        return;
      }
      const base = initial.current!;
      const patch: EventPatch = {};
      if (form.title !== base.title) patch.title = form.title;
      if (form.description !== base.description) patch.description = form.description;
      if (form.location !== base.location) patch.location = form.location;
      if (form.calendarId !== base.calendarId) patch.calendar_id = form.calendarId;
      if ((["allDay", "startDate", "startTime", "endDate", "endTime"] as const).some((k) => form[k] !== base[k])) patch.times = toTimes(form);
      const ruleChanged = form.rrule !== base.rrule;
      if (ruleChanged) {
        if (form.rrule) patch.rrule = form.rrule;
        else patch.clear_rrule = true;
      }
      if (form.alarms.join(",") !== base.alarms.join(",")) patch.alarms = form.alarms;
      if (Object.keys(patch).length === 0) {
        onClose();
        return;
      }
      let scope: EditScope = "all";
      if (occurrence?.is_recurring) {
        const chosen = await actions.promptScope("edit", !ruleChanged && !patch.calendar_id);
        if (!chosen) return;
        scope = chosen;
      }
      await update.mutateAsync({ id: target.eventId, occurrenceKey: occurrence?.occurrence_key ?? null, scope, patch });
      onClose();
    } catch {
      // The mutation already showed the error; the drawer stays open for another try.
    } finally {
      setSaving(false);
    }
  }

  const calendar = calendars.find((c) => c.id === form?.calendarId);
  const join = form ? findMeetingLink(form.location, form.description) : null;
  const heading = readOnly
    ? t("calendar.subscription.viewTitle")
    : t(target.mode === "new" ? "calendar.drawer.newTitle" : "calendar.drawer.editTitle");

  return (
    <>
      <motion.div
        aria-hidden
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={reduce ? TRANSITION_INSTANT : { duration: 0.2, ease: "easeOut" }}
        onClick={onClose}
        className="absolute inset-0 z-30 drawer-backdrop"
      />
      <motion.aside
        ref={ref}
        aria-label={heading}
        initial={reduce ? false : { x: 28, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={reduce ? { opacity: 0 } : { x: 28, opacity: 0 }}
        transition={reduce ? TRANSITION_INSTANT : SPRING_SNAPPY}
        className="fixed top-8 bottom-0 right-0 z-40 flex w-[460px] max-w-[92vw] flex-col border-l border-border bg-surface shadow-2xl"
      >
        <div className="h-[3px] shrink-0" style={{ background: calendar?.color ?? "var(--color-accent)" }} />
        <div className="flex items-center justify-between px-5 pt-4 pb-2 inset-shadow-edge">
          <span className="font-heading text-sm font-bold text-text">{heading}</span>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("common.close")}
            className="grid h-[30px] w-[30px] place-items-center rounded-lg text-text-tertiary hover:bg-hover hover:text-text"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {readOnly && detail && occurrence ? (
          <EventReadOnlyBody occurrence={occurrence} detail={detail} calendarName={calendar?.name} />
        ) : !form ? (
          <div className="space-y-3 p-5">
            <Skeleton height="2.5rem" rounded="lg" />
            <Skeleton height="8rem" rounded="lg" />
          </div>
        ) : (
          <div className="flex-1 min-h-0 space-y-5 overflow-y-auto px-5 pb-5">
            <input
              autoFocus={target.mode === "new"}
              value={form.title}
              onChange={(e) => patchForm({ title: e.target.value })}
              placeholder={t("calendar.drawer.titlePlaceholder")}
              className="w-full bg-transparent text-lg font-semibold text-text outline-none placeholder:text-text-tertiary"
            />

            <Field icon={Clock}>
              <label className="flex items-center gap-2 text-sm text-text">
                <input type="checkbox" checked={form.allDay} onChange={(e) => toggleAllDay(e.target.checked)} />
                {t("calendar.drawer.allDay")}
              </label>
              <div className="mt-2 grid grid-cols-[3.5rem_1fr_auto] items-center gap-2">
                <span className="text-xs text-text-tertiary">{t("calendar.drawer.starts")}</span>
                <DateField value={form.startDate} onChange={changeStartDate} ariaLabel={t("calendar.drawer.starts")} />
                {form.allDay ? <span /> : (
                  <TimeField value={form.startTime} onChange={changeStartTime} ariaLabel={t("calendar.drawer.starts")} />
                )}
                <span className="text-xs text-text-tertiary">{t("calendar.drawer.ends")}</span>
                <DateField value={form.endDate} min={form.startDate} onChange={(endDate) => patchForm({ endDate })} ariaLabel={t("calendar.drawer.ends")} />
                {form.allDay ? <span /> : (
                  <TimeField value={form.endTime} onChange={(endTime) => patchForm({ endTime })} ariaLabel={t("calendar.drawer.ends")} />
                )}
              </div>
              {error && <p className="mt-1.5 text-xs text-danger">{error}</p>}
            </Field>

            {!occurrence?.is_override && (
              <Field icon={Repeat} label={t("calendar.drawer.repeat")}>
                <RecurrenceEditor value={form.rrule} start={parseIsoDate(form.startDate)} onChange={(rrule) => patchForm({ rrule })} />
              </Field>
            )}

            <Field icon={CalendarDays} label={t("calendar.drawer.calendar")}>
              <Select
                value={form.calendarId}
                options={calendars.filter((c) => !c.read_only || c.id === form.calendarId).map((c) => ({
                  value: c.id,
                  label: c.name,
                  icon: <span className="h-2.5 w-2.5 rounded-full" style={{ background: c.color }} />,
                }))}
                onChange={(calendarId) => patchForm({ calendarId })}
                ariaLabel={t("calendar.drawer.calendar")}
              />
            </Field>

            <Field icon={MapPin} label={t("calendar.drawer.location")}>
              <div className="flex gap-2">
                <input
                  value={form.location}
                  onChange={(e) => patchForm({ location: e.target.value })}
                  placeholder={t("calendar.drawer.locationPlaceholder")}
                  className={`${INPUT} min-w-0 flex-1`}
                />
                {join && (
                  <Button
                    size="sm"
                    type="button"
                    onClick={() => openUrl(join).catch(() => {})}
                    icon={<Video />}
                  >
                    {t("calendar.join")}
                  </Button>
                )}
              </div>
            </Field>

            <Field icon={Bell} label={t("calendar.drawer.reminders")}>
              <AlarmEditor value={form.alarms} allDay={form.allDay} onChange={(alarms) => patchForm({ alarms })} />
            </Field>

            <Field icon={AlignLeft} label={t("calendar.drawer.description")}>
              <textarea
                value={form.description}
                onChange={(e) => patchForm({ description: e.target.value })}
                rows={5}
                placeholder={t("calendar.drawer.descriptionPlaceholder")}
                className="w-full resize-y rounded-control inset-shadow-field border border-border bg-bg-secondary px-3 py-2 text-sm text-text outline-none focus:border-accent"
              />
            </Field>

            <p className="flex items-center gap-2 text-xs text-text-tertiary">
              <Users className="h-3.5 w-3.5" />
              {t("calendar.drawer.attendeesSoon")}
            </p>
          </div>
        )}

        <div className="flex shrink-0 items-center gap-2 border-t border-border px-5 py-3">
          {!readOnly && target.mode === "edit" && occurrence && (
            <button
              type="button"
              onClick={async () => {
                if (await actions.deleteOccurrence(occurrence)) onClose();
              }}
              className="flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs text-danger hover:bg-danger/10"
            >
              <Trash2 className="h-3.5 w-3.5" />
              {t("calendar.delete")}
            </button>
          )}
          <div className="ml-auto flex gap-2">
            {readOnly ? (
              <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:bg-hover">
                {t("common.close")}
              </button>
            ) : (
              <>
                <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:bg-hover">
                  {t("common.cancel")}
                </button>
                <Button
                  size="sm"
                  type="button"
                  onClick={() => void save()}
                  disabled={!form || saving}
                >
                  {t(target.mode === "new" ? "calendar.drawer.create" : "calendar.drawer.save")}
                </Button>
              </>
            )}
          </div>
        </div>
        {actions.dialogs}
      </motion.aside>
    </>
  );
}
