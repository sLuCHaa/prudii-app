import { useMemo, useState } from "react";
import { parseISO } from "date-fns";
import { Forward, Reply } from "../icons";
import { useTranslation } from "react-i18next";
import { Tooltip } from "../ui/Tooltip";
import { ContactAvatar } from "../ui/ContactAvatar";
import { AddressName } from "./AddressName";
import { useAppStore } from "../../stores/appStore";
import { formatDateTime, formatShortDateTime } from "../../lib/dateUtils";
import { hasVisible } from "../../lib/quotedHistory";
import { cardBadge, initiallyOpen } from "../../lib/embeddedReply";
import type { EmbeddedMail } from "../../lib/embeddedMails";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T/;

interface EmbeddedMailCardsProps {
  parts: EmbeddedMail[];
  renderBody: (html: string) => React.ReactNode;
  onReply: (index: number) => void;
  onForward: (index: number) => void;
  onShowWithout: () => void;
}

function parseDate(date: string): Date | null {
  if (!ISO_DATE.test(date)) return null;
  const parsed = parseISO(date);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function EmbeddedMailCards({ parts, renderBody, onReply, onForward, onShowWithout }: EmbeddedMailCardsProps) {
  const { t } = useTranslation();
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const [open, setOpen] = useState(() => initiallyOpen(parts.length));
  // Each body is an iframe: mount it on first open, then keep it so closing can slide.
  const [mounted, setMounted] = useState(open);
  const empty = useMemo(
    () => parts.map((p) => !hasVisible(new DOMParser().parseFromString(p.html, "text/html").body)),
    [parts],
  );

  const toggle = (index: number) => {
    setOpen((prev) => prev.map((v, i) => (i === index ? !v : v)));
    setMounted((prev) => prev.map((v, i) => v || i === index));
  };

  return (
    <div className="my-2">
      <div className="flex items-center gap-3 mb-2 text-xs text-text-tertiary">
        <span>{t("mailDetail.embedded.count", { count: parts.length })}</span>
        <span aria-hidden className="flex-1 h-px bg-border" />
        <button type="button" onClick={onShowWithout} className="px-2 py-1 rounded hover:bg-hover hover:text-text-secondary transition-colors font-medium">
          {t("mailDetail.embedded.showWithout")}
        </button>
      </div>
      <div className="rounded-xl border border-border bg-surface">
        {parts.map((part, index) => {
          const isOpen = open[index];
          const last = index === parts.length - 1;
          const badge = cardBadge(parts, index);
          const name = part.from.name || part.from.email;
          const recipient = part.to[0];
          const date = parseDate(part.date);
          const forwarded = badge === "forwarded" ? t("mailDetail.embedded.forwarded") : "";
          return (
            <div key={index} className="relative">
              {index > 0 && <span aria-hidden className="absolute top-0 left-[50px] right-0 h-px bg-border" />}
              {index > 0 && <span aria-hidden className="absolute left-6 top-0 h-6 w-0.5 bg-text-tertiary/25" />}
              {!last && <span aria-hidden className="absolute left-6 top-6 bottom-0 w-0.5 bg-text-tertiary/25" />}
              <div
                className={`group flex items-center gap-1 pr-2 hover:bg-hover transition-colors ${index === 0 ? "rounded-t-[11px]" : ""} ${last && !isOpen ? "rounded-b-[11px]" : ""}`}
              >
                <button
                  type="button"
                  aria-expanded={isOpen}
                  onClick={() => toggle(index)}
                  className="flex flex-1 min-w-0 items-center gap-3 pl-3 py-2 text-left text-xs"
                >
                  <ContactAvatar
                    name={part.from.name}
                    email={part.from.email}
                    size={26}
                    className={`relative ring-[3px] ring-surface group-hover:ring-hover transition-shadow ${badge === "original" ? "outline-[1.5px] outline-accent outline-offset-[3px]" : ""}`}
                  />
                  <span className="min-w-0 flex flex-1 flex-col">
                    <span className="flex items-baseline gap-1.5 min-w-0">
                      <AddressName address={part.from} className="block font-medium text-text truncate">{name}</AddressName>
                      {isOpen && part.from.email && part.from.email !== name && (
                        <AddressName address={part.from} className="min-w-0 shrink-[10] truncate text-text-tertiary">{part.from.email}</AddressName>
                      )}
                      {badge === "original" && (
                        <span className="min-w-0 shrink-[100] truncate text-[11px] font-medium text-accent-hover">{t("mailDetail.embedded.original")}</span>
                      )}
                    </span>
                    <span className="truncate text-text-tertiary">
                      {recipient && (
                        <AddressName address={recipient}>{t("mailDetail.embedded.to", { name: recipient.name || recipient.email })}</AddressName>
                      )}
                      {!isOpen && part.preview && `${recipient ? " · " : ""}${part.preview}`}
                    </span>
                  </span>
                  {date ? (
                    <Tooltip className="shrink-0" label={[forwarded, formatDateTime(date, use24h)].filter(Boolean).join(" · ")}>
                      <span className="flex items-center gap-1 tabular-nums text-text-tertiary">
                        {forwarded && <Forward aria-hidden className="w-3 h-3" />}
                        {formatShortDateTime(date, use24h)}
                      </span>
                    </Tooltip>
                  ) : (
                    part.date && <span className="shrink-0 text-text-tertiary">{part.date}</span>
                  )}
                </button>
                <div className={`flex items-center transition-opacity ${isOpen ? "" : "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"}`}>
                  <Tooltip label={t("mailDetail.embedded.reply", { name })}>
                    <button
                      type="button"
                      aria-label={t("mailDetail.embedded.reply", { name })}
                      onClick={() => onReply(index)}
                      className="p-1.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-surface transition-colors"
                    >
                      <Reply className="w-4 h-4" />
                    </button>
                  </Tooltip>
                  <Tooltip label={t("mailDetail.embedded.forward")}>
                    <button
                      type="button"
                      aria-label={t("mailDetail.embedded.forward")}
                      onClick={() => onForward(index)}
                      className="p-1.5 rounded text-text-tertiary hover:text-text-secondary hover:bg-surface transition-colors"
                    >
                      <Forward className="w-4 h-4" />
                    </button>
                  </Tooltip>
                </div>
              </div>
              <div className={`reveal-y ${isOpen ? "reveal-open" : ""}`}>
                <div inert={!isOpen}>
                  {mounted[index] && (
                    <div className={`pl-[50px] pr-4 pb-3 transition-opacity duration-200 motion-reduce:transition-none ${isOpen ? "opacity-100" : "opacity-0"}`}>
                      {empty[index] ? (
                        <p className="py-2 text-xs text-text-tertiary">{t("mailDetail.embedded.noText")}</p>
                      ) : (
                        renderBody(part.html)
                      )}
                    </div>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
