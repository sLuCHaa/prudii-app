import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { AlertTriangle, CalendarClock, CalendarX, ChevronDown, MapPin, Repeat, User, Users, Video } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { InvitationView, InviteAnswer, InviteChanges } from "../../types/calendar";
import { useAddPublishedEvent, useCalendars, useMailInvitation, useRemoveCancelledEvent, useRespondInvitation } from "../../hooks/useCalendar";
import { useAppStore } from "../../stores/appStore";
import { occurrenceRange } from "../../lib/calendar/dates";
import { formatOccurrenceTime, formatSpan } from "../../lib/calendar/format";
import { describeRrule } from "../../lib/calendar/rrule";
import { ANSWERS, cardMode, conflictLine, originalTime, replyMail, statusKey } from "../../lib/calendar/invitation";
import { dateLocale } from "../../lib/dateUtils";
import type { MenuEntry } from "../../lib/menuModel";
import { ContextMenu } from "../ui/ContextMenu";
import { Select } from "../ui/Select";
import { LinkifiedText } from "./LinkifiedText";

const ANSWER_LABELS: Record<InviteAnswer, string> = {
  accepted: "calendar.invite.accept",
  tentative: "calendar.invite.tentative",
  declined: "calendar.invite.decline",
};

export function InvitationCard({ mailId, enabled }: { mailId: string; enabled: boolean }) {
  const { data: view } = useMailInvitation(mailId, enabled);
  return view ? <Card view={view} /> : null;
}

function Line({ icon: Icon, children }: { icon: typeof MapPin; children: ReactNode }) {
  return (
    <div className="mt-1.5 flex items-start gap-2 text-xs text-text-secondary">
      <Icon className="mt-px h-3.5 w-3.5 shrink-0 text-text-tertiary" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <p className="mt-2.5 rounded-lg bg-warning/10 px-2.5 py-1.5 text-xs text-text-secondary">{children}</p>;
}

function UpdateNote({ changes, use24h, allDay }: { changes: InviteChanges; use24h: boolean; allDay: string }) {
  const { t } = useTranslation();
  return (
    <div className="mt-2.5 rounded-lg bg-accent/5 px-2.5 py-2 text-xs text-text-secondary">
      <p className="font-medium text-accent">{t("calendar.invite.updated")}</p>
      {changes.time && (
        <p className="mt-0.5">
          {t("calendar.invite.changedTime", { old: formatSpan(changes.time.old, use24h, allDay), new: formatSpan(changes.time.new, use24h, allDay) })}
        </p>
      )}
      {changes.location && (
        <p className="mt-0.5">{t("calendar.invite.changedLocation", { old: changes.location.old || "—", new: changes.location.new || "—" })}</p>
      )}
      {changes.title && <p className="mt-0.5">{t("calendar.invite.changedTitle", { old: changes.title.old, new: changes.title.new })}</p>}
    </div>
  );
}

function Card({ view }: { view: InvitationView }) {
  const { t, i18n } = useTranslation();
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const addToast = useAppStore((s) => s.addToast);
  const { data: calendars = [] } = useCalendars();
  const respond = useRespondInvitation();
  const addPublished = useAddPublishedEvent();
  const removeCancelled = useRemoveCancelledEvent();
  const [picked, setPicked] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ answer: InviteAnswer; x: number; y: number } | null>(null);
  const [commenting, setCommenting] = useState<InviteAnswer | null>(null);
  const [comment, setComment] = useState("");

  const mode = cardMode(view);
  const writable = calendars.filter((c) => !c.read_only);
  const calendarId = view.calendar_id ?? picked ?? writable.find((c) => c.is_default)?.id ?? writable[0]?.id ?? "";
  const busy = respond.isPending || addPublished.isPending || removeCancelled.isPending;
  const { start } = occurrenceRange(view.when);
  const allDay = t("calendar.allDay");
  const original = originalTime(view.when, view.tzid, Intl.DateTimeFormat().resolvedOptions().timeZone, i18n.language, use24h);
  const conflicts = mode === "cancel" ? null : conflictLine(t, view.conflicts, view.conflict_count);
  const organizer = view.organizer_name || view.organizer_email;
  const status = statusKey(view.my_partstat);
  const join = mode === "cancel" ? null : view.meeting_link;
  const canPickCalendar = (mode === "request" || mode === "publish") && !view.calendar_id && writable.length > 1;

  function answer(a: InviteAnswer, sendReply: boolean, note: string | null) {
    const mail = replyMail(t, a, view.title, note);
    respond.mutate(
      { mailId: view.mail_id, partstat: a, calendarId, sendReply, comment: note?.trim() || null, replySubject: mail.subject, replyBody: mail.body },
      {
        onSuccess: () => {
          setCommenting(null);
          setComment("");
          if (sendReply) addToast("success", t("calendar.invite.replySent"));
        },
      },
    );
  }

  const menuEntries = (a: InviteAnswer): MenuEntry[] => [
    { kind: "item", id: "send", label: t("calendar.invite.sendReply"), selected: view.rsvp, onSelect: () => answer(a, true, null) },
    { kind: "item", id: "comment", label: t("calendar.invite.withComment"), onSelect: () => { setComment(""); setCommenting(a); } },
    { kind: "item", id: "none", label: t("calendar.invite.noReply"), selected: !view.rsvp, onSelect: () => answer(a, false, null) },
  ];

  return (
    <div className="mb-3 rounded-xl border border-border bg-bg-secondary/60 p-3.5">
      <div className="flex items-start gap-3">
        <div className="mt-0.5 flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-accent/10 text-accent">
          {mode === "cancel" ? <CalendarX className="h-[18px] w-[18px]" /> : <CalendarClock className="h-[18px] w-[18px]" />}
        </div>
        <div className="min-w-0 flex-1">
          <h3 className={`break-words text-sm font-semibold ${mode === "cancel" ? "text-text-tertiary line-through" : "text-text"}`}>
            {view.title || t("calendar.untitled")}
          </h3>
          <p className="mt-0.5 text-xs text-text-secondary">
            {format(start, "PPPP", { locale: dateLocale() })} · {formatOccurrenceTime(view.when, use24h, allDay)}
          </p>
          {original && <p className="text-xs text-text-tertiary">{t("calendar.invite.originalTime", { time: original })}</p>}
          {view.rrule && (
            <p className="mt-0.5 flex items-center gap-1 text-xs text-text-tertiary">
              <Repeat className="h-3 w-3" />
              {describeRrule(view.rrule, start, t, dateLocale(), i18n.language)}
            </p>
          )}
        </div>
      </div>

      {view.location && (
        <Line icon={MapPin}>
          <LinkifiedText text={view.location} />
        </Line>
      )}
      {organizer && <Line icon={User}>{t("calendar.invite.organizer", { name: organizer })}</Line>}
      {view.attendee_count > 0 && <Line icon={Users}>{t("calendar.invite.attendees", { count: view.attendee_count })}</Line>}
      {conflicts && <Line icon={AlertTriangle}>{conflicts}</Line>}
      {mode === "request" && view.updated && <UpdateNote changes={view.changes} use24h={use24h} allDay={allDay} />}
      {mode === "outdated" && <Notice>{t("calendar.invite.outdated")}</Notice>}
      {mode === "cancel" && <Notice>{t("calendar.invite.cancelled")}</Notice>}
      {mode === "publish" && view.event_count > 1 && (
        <p className="mt-1.5 text-xs text-text-tertiary">{t("calendar.invite.moreEvents", { count: view.event_count - 1 })}</p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {join && (
          <button
            type="button"
            onClick={() => openUrl(join).catch(() => {})}
            className="flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90"
          >
            <Video className="h-3.5 w-3.5" />
            {t("calendar.join")}
          </button>
        )}
        {mode === "request" &&
          ANSWERS.map((a) => {
            const current = view.my_partstat === a;
            return (
              <div
                key={a}
                className={`flex items-stretch overflow-hidden rounded-lg border text-xs font-medium ${current ? "border-accent bg-accent/10 text-accent" : "border-border text-text-secondary"}`}
              >
                <button
                  type="button"
                  disabled={busy || !calendarId}
                  aria-pressed={current}
                  onClick={() => answer(a, view.rsvp, null)}
                  className="px-3 py-1.5 hover:bg-hover disabled:opacity-50"
                >
                  {t(ANSWER_LABELS[a])}
                </button>
                <button
                  type="button"
                  disabled={busy || !calendarId}
                  aria-label={t("calendar.invite.answerOptions")}
                  aria-haspopup="menu"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenu({ answer: a, x: r.left, y: r.bottom + 4 });
                  }}
                  className={`border-l px-1.5 hover:bg-hover disabled:opacity-50 ${current ? "border-accent/40" : "border-border"}`}
                >
                  <ChevronDown className="h-3.5 w-3.5" />
                </button>
              </div>
            );
          })}
        {mode === "publish" &&
          (view.event_id ? (
            <span className="text-xs text-text-tertiary">{t("calendar.invite.inCalendar")}</span>
          ) : (
            <button
              type="button"
              disabled={busy || !calendarId}
              onClick={() => addPublished.mutate({ mailId: view.mail_id, calendarId })}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {t("calendar.invite.addToCalendar")}
            </button>
          ))}
        {mode === "cancel" && view.event_id && (
          <button
            type="button"
            disabled={busy}
            onClick={() => removeCancelled.mutate(view.mail_id)}
            className="rounded-lg border border-border px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 disabled:opacity-50"
          >
            {t("calendar.invite.removeFromCalendar")}
          </button>
        )}
        {canPickCalendar && (
          <div className="ml-auto w-44">
            <Select
              value={calendarId}
              options={writable.map((c) => ({ value: c.id, label: c.name }))}
              onChange={setPicked}
              ariaLabel={t("calendar.invite.calendar")}
              className="flex w-full items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-left text-xs text-text focus:border-accent"
            />
          </div>
        )}
      </div>

      {mode === "request" && status && <p className="mt-2 text-xs text-text-tertiary">{t(status)}</p>}

      {commenting && (
        <div className="mt-2.5 flex flex-col gap-2">
          <textarea
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={2}
            autoFocus
            placeholder={t("calendar.invite.commentPlaceholder")}
            className="w-full resize-y rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs text-text outline-none focus:border-accent"
          />
          <div className="flex justify-end gap-1.5">
            <button type="button" onClick={() => setCommenting(null)} className="rounded-lg px-2.5 py-1 text-xs text-text-secondary hover:bg-hover">
              {t("calendar.invite.cancel")}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => answer(commenting, true, comment)}
              className="rounded-lg bg-accent px-2.5 py-1 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {t(ANSWER_LABELS[commenting])} · {t("calendar.invite.send")}
            </button>
          </div>
        </div>
      )}

      {menu && <ContextMenu entries={menuEntries(menu.answer)} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
    </div>
  );
}
