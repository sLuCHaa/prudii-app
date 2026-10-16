import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { AlignLeft, CalendarDays, Clock, Link2, MapPin, Video } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { EventDetail, Occurrence } from "../../types/calendar";
import { useAppStore } from "../../stores/appStore";
import { occurrenceRange } from "../../lib/calendar/dates";
import { describeRrule } from "../../lib/calendar/rrule";
import { findMeetingLink } from "../../lib/calendar/meetingLinks";
import { formatOccurrenceTime } from "../../lib/calendar/format";
import { dateLocale } from "../../lib/dateUtils";
import { LinkifiedText } from "./LinkifiedText";

function Row({ icon: Icon, children }: { icon: typeof MapPin; children: ReactNode }) {
  return (
    <div className="flex gap-3 text-sm text-text">
      <Icon className="mt-0.5 h-4 w-4 shrink-0 text-text-tertiary" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

interface EventReadOnlyBodyProps {
  occurrence: Occurrence;
  detail: EventDetail;
  calendarName?: string;
}

/** A subscribed event in the drawer: everything visible, nothing editable. */
export function EventReadOnlyBody({ occurrence: o, detail, calendarName }: EventReadOnlyBodyProps) {
  const { t, i18n } = useTranslation();
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const { start } = occurrenceRange(o);
  const rule = detail.event.rrule;
  const join = findMeetingLink(o.location, o.description);
  return (
    <div className="flex-1 min-h-0 space-y-4 overflow-y-auto px-5 pb-5">
      <h2 className="text-lg font-semibold text-text break-words">{o.title || t("calendar.untitled")}</h2>
      <Row icon={Clock}>
        <div>{format(start, "PPPP", { locale: dateLocale() })}</div>
        <div className="text-text-secondary">{formatOccurrenceTime(o, use24h, t("calendar.allDay"))}</div>
        {rule && <div className="mt-0.5 text-xs text-text-tertiary">{describeRrule(rule, start, t, dateLocale(), i18n.language)}</div>}
      </Row>
      {o.location && (
        <Row icon={MapPin}>
          <LinkifiedText text={o.location} />
        </Row>
      )}
      {join && (
        <button
          type="button"
          onClick={() => openUrl(join).catch(() => {})}
          className="ml-7 flex items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90"
        >
          <Video className="h-3.5 w-3.5" />
          {t("calendar.join")}
        </button>
      )}
      {o.description && (
        <Row icon={AlignLeft}>
          <div className="whitespace-pre-wrap">
            <LinkifiedText text={o.description} />
          </div>
        </Row>
      )}
      {calendarName && <Row icon={CalendarDays}>{calendarName}</Row>}
      <p className="flex items-center gap-2 text-xs text-text-tertiary">
        <Link2 className="h-3.5 w-3.5" />
        {t("calendar.subscription.readOnly")}
      </p>
    </div>
  );
}
