import { useMemo, useState } from "react";
import { parseISO } from "date-fns";
import { ChevronRight, Forward, Reply } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Tooltip } from "../ui/Tooltip";
import { ContactAvatar } from "../ui/ContactAvatar";
import { useAppStore } from "../../stores/appStore";
import { formatDateTime } from "../../lib/dateUtils";
import { hasVisible } from "../../lib/quotedHistory";
import { cardBadge, initiallyOpen } from "../../lib/embeddedReply";
import type { EmbeddedMail } from "../../lib/embeddedMails";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

const BADGE_CLASS = {
  original: "bg-accent/10 text-accent",
  forwarded: "bg-bg-tertiary text-text-secondary",
};

interface EmbeddedMailCardsProps {
  parts: EmbeddedMail[];
  renderBody: (html: string) => React.ReactNode;
  onReply: (index: number) => void;
  onForward: (index: number) => void;
  onShowWithout: () => void;
}

export function EmbeddedMailCards({ parts, renderBody, onReply, onForward, onShowWithout }: EmbeddedMailCardsProps) {
  const { t } = useTranslation();
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const [open, setOpen] = useState(() => initiallyOpen(parts.length));
  const empty = useMemo(
    () => parts.map((p) => !hasVisible(new DOMParser().parseFromString(p.html, "text/html").body)),
    [parts],
  );

  const toggle = (index: number) => setOpen((prev) => prev.map((v, i) => (i === index ? !v : v)));
  const formatDate = (date: string) => {
    if (!ISO_DATE.test(date)) return date;
    const parsed = parseISO(date);
    return Number.isNaN(parsed.getTime()) ? date : formatDateTime(parsed, use24h);
  };

  return (
    <div className="my-2">
      <div className="flex items-center justify-between gap-3 mb-2 text-xs text-text-tertiary">
        <span>{t("mailDetail.embedded.count", { count: parts.length })}</span>
        <button type="button" onClick={onShowWithout} className="px-2 py-1 rounded hover:bg-hover transition-colors font-medium">
          {t("mailDetail.embedded.showWithout")}
        </button>
      </div>
      <div className="flex flex-col gap-2">
        {parts.map((part, index) => {
          const isOpen = open[index];
          const badge = cardBadge(parts, index);
          const name = part.from.name || part.from.email;
          const recipient = part.to[0];
          return (
            <div key={index} className={`rounded-xl border border-border ${isOpen ? "bg-surface" : "bg-bg-secondary"}`}>
              <div className="flex items-center gap-1 pr-2">
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggle(index)}
                  className="flex flex-1 min-w-0 items-center gap-2 px-3 py-2 text-left text-xs"
                >
                  <ChevronRight className={`w-3.5 h-3.5 shrink-0 text-text-tertiary transition-transform ${isOpen ? "rotate-90" : ""}`} />
                  <ContactAvatar name={part.from.name} email={part.from.email} size={26} className="shrink-0" />
                  <span className="min-w-0 flex flex-1 flex-col">
                    <span className="flex items-baseline gap-1.5 min-w-0">
                      <span className="font-medium text-text-primary truncate">{name}</span>
                      {part.from.email && part.from.email !== name && (
                        <span className="text-text-tertiary truncate">{part.from.email}</span>
                      )}
                    </span>
                    <span className="truncate text-text-tertiary">
                      {recipient && t("mailDetail.embedded.to", { name: recipient.name || recipient.email })}
                      {!isOpen && part.preview && `${recipient ? " · " : ""}${part.preview}`}
                    </span>
                  </span>
                  {part.date && <span className="shrink-0 text-text-tertiary">{formatDate(part.date)}</span>}
                  {badge && (
                    <span className={`shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${BADGE_CLASS[badge]}`}>
                      {t(`mailDetail.embedded.${badge}`)}
                    </span>
                  )}
                </button>
                <Tooltip label={t("mailDetail.embedded.reply", { name })}>
                  <button
                    type="button"
                    aria-label={t("mailDetail.embedded.reply", { name })}
                    onClick={() => onReply(index)}
                    className="p-1.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-hover transition-colors"
                  >
                    <Reply className="w-4 h-4" />
                  </button>
                </Tooltip>
                <Tooltip label={t("mailDetail.embedded.forward")}>
                  <button
                    type="button"
                    aria-label={t("mailDetail.embedded.forward")}
                    onClick={() => onForward(index)}
                    className="p-1.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-hover transition-colors"
                  >
                    <Forward className="w-4 h-4" />
                  </button>
                </Tooltip>
              </div>
              {isOpen && (
                <div className="px-3 pb-2">
                  {empty[index] ? (
                    <p className="py-2 text-xs text-text-tertiary">{t("mailDetail.embedded.noText")}</p>
                  ) : (
                    renderBody(part.html)
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
