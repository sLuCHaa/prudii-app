import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { Check, Forward, Pencil, Quote, RotateCcw, X } from "lucide-react";
import { Button, IconButton } from "../ui/Button";
import { GradientAvatar } from "../motion/GradientAvatar";
import { HtmlMailFrame } from "../layout/MailDetail";
import { dateLocale } from "../../lib/dateUtils";
import type { ComposeQuote } from "../../lib/composeQuote";

interface QuoteCardProps {
  quote: ComposeQuote;
  editing: boolean;
  onEdit: () => void;
  onDone: () => void;
  onRestore: () => void;
  onRemove: () => void;
  onFrameRef: (el: HTMLIFrameElement | null) => void;
  onFrameLoad: () => void;
  onEditBaseline: (html: string) => void;
}

function cardDate(date: string): string {
  const d = new Date(date);
  return isNaN(d.getTime()) ? date : format(d, "PPp", { locale: dateLocale() });
}

export function QuoteCard({ quote, editing, onEdit, onDone, onRestore, onRemove, onFrameRef, onFrameLoad, onEditBaseline }: QuoteCardProps) {
  const { t } = useTranslation();
  const forward = quote.kind === "forward";
  const meta = quote.kind === "raw" ? null : quote.meta;
  const details = meta ? [forward && meta.to ? t("compose.quoteTo", { to: meta.to }) : "", cardDate(meta.date)].filter(Boolean).join(" · ") : "";

  return (
    <div
      className={`rounded-xl border overflow-hidden transition-shadow ${
        editing ? "border-accent ring-4 ring-accent/15" : "border-border"
      }`}
    >
      <div
        className={`flex items-center gap-2 pl-3.5 pr-2 py-1.5 border-b ${
          editing ? "bg-accent/10 border-accent/25" : "bg-bg-secondary border-border"
        }`}
      >
        {editing ? (
          <>
            <Pencil className="w-3.5 h-3.5 shrink-0 text-accent" />
            <span className="text-xs font-semibold text-accent truncate">
              {t(forward ? "compose.quoteEditingForward" : "compose.quoteEditingReply")}
            </span>
            <div className="ml-auto flex items-center gap-1.5 shrink-0">
              <Button type="button" variant="secondary" size="sm" icon={<RotateCcw />} onClick={onRestore}>
                {t("compose.quoteRestore")}
              </Button>
              <Button type="button" size="sm" icon={<Check />} onClick={onDone}>
                {t("compose.quoteDone")}
              </Button>
            </div>
          </>
        ) : (
          <>
            {forward ? (
              <Forward className="w-3.5 h-3.5 shrink-0 text-text-tertiary" />
            ) : (
              <Quote className="w-3.5 h-3.5 shrink-0 text-text-tertiary" />
            )}
            <span className="text-xs font-medium text-text-secondary truncate">
              {t(forward ? "compose.quoteForwarded" : "compose.quotedMessage")}
            </span>
            <div className="ml-auto flex items-center gap-1 shrink-0">
              {/* An empty body is still loading; edits made now would be overwritten by it. */}
              <Button type="button" variant="secondary" size="sm" icon={<Pencil />} onClick={onEdit} disabled={!quote.body.trim()}>
                {t("compose.quoteEdit")}
              </Button>
              <IconButton
                type="button"
                size="sm"
                icon={<X />}
                aria-label={t(forward ? "compose.quoteRemoveForward" : "compose.quoteRemoveReply")}
                title={t(forward ? "compose.quoteRemoveForward" : "compose.quoteRemoveReply")}
                onClick={onRemove}
              />
            </div>
          </>
        )}
      </div>

      {meta && (
        <div className="flex items-center gap-2.5 px-3.5 py-2.5 bg-bg-secondary border-b border-border">
          <GradientAvatar name={meta.fromName} email={meta.fromEmail} size={30} />
          <div className="flex-1 min-w-0 leading-snug">
            <div className="text-sm truncate">
              <span className="font-semibold text-text">{meta.fromName || meta.fromEmail}</span>
              {meta.fromName && <span className="ml-1.5 text-xs text-text-tertiary">{meta.fromEmail}</span>}
            </div>
            {details && <div className="text-xs text-text-tertiary truncate">{details}</div>}
            {forward && meta.subject && <div className="text-sm font-medium text-text truncate">{meta.subject}</div>}
          </div>
        </div>
      )}

      <HtmlMailFrame
        html={quote.body}
        allowExternalImages
        editable={editing}
        onIframeRef={onFrameRef}
        onLoad={onFrameLoad}
        onEditBaseline={onEditBaseline}
      />
    </div>
  );
}
