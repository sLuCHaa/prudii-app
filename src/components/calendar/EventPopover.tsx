import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { motion, useReducedMotion } from "motion/react";
import { format } from "date-fns";
import { AlignLeft, CalendarDays, Link2, MapPin, Pencil, Repeat, Trash2, Video } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { ReactNode } from "react";
import type { Occurrence } from "../../types/calendar";
import { useEvent } from "../../hooks/useCalendar";
import { useAppStore } from "../../stores/appStore";
import { occurrenceRange } from "../../lib/calendar/dates";
import { describeRrule } from "../../lib/calendar/rrule";
import { findMeetingLink } from "../../lib/calendar/meetingLinks";
import { formatOccurrenceTime } from "../../lib/calendar/format";
import { dateLocale } from "../../lib/dateUtils";
import { SPRING_SNAPPY, TRANSITION_INSTANT } from "../motion/tokens";
import { LinkifiedText } from "./LinkifiedText";
import { usePopover } from "./usePopover";
import { Button } from "../ui/Button";

interface EventPopoverProps {
  occurrence: Occurrence;
  anchor: DOMRect;
  calendarName?: string;
  onClose: () => void;
  onEdit: (o: Occurrence) => void;
  onDelete: (o: Occurrence) => void;
}

function Row({ icon: Icon, children }: { icon: typeof MapPin; children: ReactNode }) {
  return (
    <div className="mt-2.5 flex items-start gap-2.5 text-xs text-text-secondary">
      <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0 text-text-tertiary" />
      <div className="min-w-0 flex-1 break-words">{children}</div>
    </div>
  );
}

export function EventPopover({ occurrence: o, anchor, calendarName, onClose, onEdit, onDelete }: EventPopoverProps) {
  const { t, i18n } = useTranslation();
  const reduce = useReducedMotion();
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const { data: detail } = useEvent(o.event_id);
  const { ref, pos } = usePopover(anchor, onClose);
  const { start } = occurrenceRange(o);
  const rule = detail?.event.rrule ?? null;
  const join = findMeetingLink(o.location, o.description);
  const cancelled = o.status === "cancelled";

  return createPortal(
    <motion.div
      ref={ref}
      role="dialog"
      tabIndex={-1}
      aria-label={o.title || t("calendar.untitled")}
      initial={reduce ? false : { opacity: 0, scale: 0.97 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={reduce ? TRANSITION_INSTANT : SPRING_SNAPPY}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 w-[300px] rounded-xl border border-border bg-surface p-4 shadow-2xl inset-shadow-edge"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-1.5 w-2.5 h-2.5 rounded-full shrink-0" style={{ background: o.color }} />
        <div className="min-w-0 flex-1">
          <h3 className={`text-sm font-semibold break-words ${cancelled ? "line-through text-text-tertiary" : "text-text"}`}>
            {o.title || t("calendar.untitled")}
          </h3>
          <p className="mt-0.5 text-xs text-text-secondary">{format(start, "PPPP", { locale: dateLocale() })}</p>
          <p className="text-xs text-text-secondary">{formatOccurrenceTime(o, use24h, t("calendar.allDay"))}</p>
          {rule && (
            <p className="mt-1 flex items-center gap-1 text-xs text-text-tertiary">
              <Repeat className="w-3 h-3" />
              {describeRrule(rule, start, t, dateLocale(), i18n.language)}
            </p>
          )}
        </div>
      </div>
      {o.location && (
        <Row icon={MapPin}>
          <LinkifiedText text={o.location} />
        </Row>
      )}
      {o.description && (
        <Row icon={AlignLeft}>
          <div className="line-clamp-6 whitespace-pre-wrap">
            <LinkifiedText text={o.description} />
          </div>
        </Row>
      )}
      {calendarName && <Row icon={CalendarDays}>{calendarName}</Row>}
      <div className="mt-4 flex items-center gap-1.5">
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
        {o.read_only ? (
          <span className="ml-auto flex items-center gap-1 text-xs text-text-tertiary">
            <Link2 className="w-3.5 h-3.5" />
            {t("calendar.subscription.readOnly")}
          </span>
        ) : (
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => onEdit(o)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-hover"
            >
              <Pencil className="w-3.5 h-3.5" />
              {t("calendar.edit")}
            </button>
            <button
              type="button"
              onClick={() => onDelete(o)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-xs text-danger hover:bg-danger/10"
            >
              <Trash2 className="w-3.5 h-3.5" />
              {t("calendar.delete")}
            </button>
          </div>
        )}
      </div>
    </motion.div>,
    document.body,
  );
}
