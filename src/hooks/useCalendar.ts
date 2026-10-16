import { keepPreviousData, useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  countTodayOccurrences, createCalendar, createEvent, deleteCalendar, deleteEvent, exportIcs, getCalendarSettings, getEvent,
  importCalendarFiles, importIcs, listCalendars, listOccurrences, moveOccurrence, refreshSubscription, searchEvents, subscribeCalendar, tasksInRange, updateCalendar, updateCalendarSettings,
  updateEvent, updateSubscriptionUrl,
} from "../lib/tauri";
import type { CalendarPatch, CalendarSettings, EditScope, EventInput, EventPatch, EventTimes } from "../types/calendar";
import { useAppStore } from "../stores/appStore";
import i18n from "../lib/i18n";

const CALENDAR_QUERY_KEYS = ["calendars", "occurrences", "event", "calendar-today", "calendar-search", "calendar-settings"];

export function invalidateCalendarQueries(queryClient: QueryClient) {
  for (const key of CALENDAR_QUERY_KEYS) queryClient.invalidateQueries({ queryKey: [key] });
}

/** Backend errors are either `calendar.errors.*` keys or plain diagnostics. */
export function calendarErrorToast(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  const { addToast } = useAppStore.getState();
  if (i18n.exists(message)) addToast("error", i18n.t(message));
  else addToast("error", i18n.t("errors.generic"), message);
}

export function useCalendars() {
  const { t } = useTranslation();
  return useQuery({ queryKey: ["calendars"], queryFn: () => listCalendars(t("calendar.defaultName")), staleTime: 60_000 });
}

export function useOccurrences(from: Date, to: Date, enabled = true) {
  const f = from.toISOString();
  const tt = to.toISOString();
  return useQuery({
    queryKey: ["occurrences", f, tt],
    queryFn: () => listOccurrences(f, tt),
    placeholderData: keepPreviousData,
    staleTime: 10_000,
    enabled,
  });
}

export function useEvent(id: string | null) {
  return useQuery({ queryKey: ["event", id], queryFn: () => getEvent(id!), enabled: !!id });
}

export function useTodayCount() {
  return useQuery({ queryKey: ["calendar-today"], queryFn: countTodayOccurrences, refetchInterval: 5 * 60_000 });
}

export function useTasksInRange(from: Date, to: Date, enabled: boolean) {
  const f = from.toISOString();
  const tt = to.toISOString();
  return useQuery({ queryKey: ["tasks-in-range", f, tt], queryFn: () => tasksInRange(f, tt), placeholderData: keepPreviousData, enabled });
}

export function useCalendarSettings() {
  return useQuery({ queryKey: ["calendar-settings"], queryFn: getCalendarSettings, staleTime: 5 * 60_000 });
}

export function useSearchEvents(query: string) {
  const q = query.trim();
  return useQuery({
    queryKey: ["calendar-search", q],
    queryFn: () => {
      const from = new Date();
      from.setHours(0, 0, 0, 0);
      return searchEvents(q, from.toISOString());
    },
    enabled: q.length >= 2,
    placeholderData: keepPreviousData,
  });
}

function useCalendarMutation<V, R>(mutationFn: (vars: V) => Promise<R>) {
  const queryClient = useQueryClient();
  return useMutation({ mutationFn, onSuccess: () => invalidateCalendarQueries(queryClient), onError: calendarErrorToast });
}

export function useCreateEvent() {
  return useCalendarMutation((input: EventInput) => createEvent(input));
}

export function useUpdateEvent() {
  return useCalendarMutation((v: { id: string; occurrenceKey: string | null; scope: EditScope; patch: EventPatch }) =>
    updateEvent(v.id, v.occurrenceKey, v.scope, v.patch),
  );
}

export function useDeleteEvent() {
  return useCalendarMutation((v: { id: string; occurrenceKey: string | null; scope: EditScope }) => deleteEvent(v.id, v.occurrenceKey, v.scope));
}

export function useMoveOccurrence() {
  return useCalendarMutation((v: { id: string; occurrenceKey: string | null; times: EventTimes; scope: EditScope }) =>
    moveOccurrence(v.id, v.occurrenceKey, v.times, v.scope),
  );
}

export function useCreateCalendar() {
  return useCalendarMutation((v: { name: string; color: string }) => createCalendar(v.name, v.color));
}

export function useUpdateCalendar() {
  return useCalendarMutation((v: { id: string; patch: CalendarPatch }) => updateCalendar(v.id, v.patch));
}

export function useDeleteCalendar() {
  return useCalendarMutation((id: string) => deleteCalendar(id));
}

export function useUpdateCalendarSettings() {
  return useCalendarMutation((settings: CalendarSettings) => updateCalendarSettings(settings));
}

export function useImportIcs() {
  return useCalendarMutation((calendarId: string) => importIcs(calendarId));
}

export function useExportIcs() {
  return useMutation({ mutationFn: (calendarId: string) => exportIcs(calendarId), onError: calendarErrorToast });
}

export function useImportCalendarFiles() {
  return useCalendarMutation((untitledName: string) => importCalendarFiles(untitledName));
}

/** No error toast: the dialog shows the reason next to the link field. */
export function useSubscribeCalendar() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { url: string; color: string; refreshMinutes: number }) => subscribeCalendar(v.url, v.color, v.refreshMinutes),
    onSuccess: () => invalidateCalendarQueries(queryClient),
  });
}

export function useUpdateSubscriptionUrl() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (v: { id: string; url: string }) => updateSubscriptionUrl(v.id, v.url),
    onSuccess: () => invalidateCalendarQueries(queryClient),
  });
}

/** Invalidates on failure too: the calendar's status changed either way. */
export function useRefreshSubscription() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => refreshSubscription(id),
    onSettled: () => invalidateCalendarQueries(queryClient),
    onError: calendarErrorToast,
  });
}
