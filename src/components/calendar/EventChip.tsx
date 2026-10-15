import { useTranslation } from "react-i18next";
import type { Occurrence } from "../../types/calendar";
import { formatTime } from "../../lib/dateUtils";
import { isoDate } from "../../lib/calendar/dates";
import { grabbedDayIndex } from "../../lib/calendar/drag";
import { OCCURRENCE_MIME, occurrenceId } from "./gridShared";

interface EventChipProps {
  occurrence: Occurrence;
  variant: "bar" | "dot";
  use24h: boolean;
  onOpen: (o: Occurrence, rect: DOMRect) => void;
  /** The visible days a bar covers, in order. */
  spanDays?: Date[];
}

export function EventChip({ occurrence: o, variant, use24h, onOpen, spanDays }: EventChipProps) {
  const { t } = useTranslation();
  const label = o.title || t("calendar.untitled");
  const muted = o.status === "cancelled" || o.my_partstat === "declined";
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        const id = occurrenceId(o);
        let grabbed: string | undefined;
        if (spanDays?.length) {
          const rect = e.currentTarget.getBoundingClientRect();
          grabbed = isoDate(spanDays[grabbedDayIndex(e.clientX, rect.left, rect.width, spanDays.length)]);
        }
        e.dataTransfer.setData(OCCURRENCE_MIME, JSON.stringify(grabbed ? { id, grabbed } : { id }));
        e.dataTransfer.effectAllowed = "move";
      }}
      onClick={(e) => {
        e.stopPropagation();
        onOpen(o, e.currentTarget.getBoundingClientRect());
      }}
      title={label}
      className={`w-full min-w-0 h-5 flex items-center gap-1.5 px-1.5 rounded-md text-left text-[11px] leading-5 transition-colors ${
        variant === "bar" ? "text-white hover:brightness-110" : "text-text hover:bg-hover"
      } ${muted ? "opacity-60 line-through" : ""}`}
      style={variant === "bar" ? { background: o.color } : undefined}
    >
      {variant === "dot" && <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: o.color }} />}
      {variant === "dot" && !o.all_day && <span className="shrink-0 text-text-tertiary tabular-nums">{formatTime(new Date(o.start), use24h)}</span>}
      <span className="truncate">{label}</span>
    </button>
  );
}
