import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ChevronDown, Rss } from "lucide-react";
import type { Calendar } from "../../types/calendar";
import { getSubscriptionUrl } from "../../lib/tauri";
import { useCalendars, useSubscribeCalendar, useUpdateSubscriptionUrl } from "../../hooks/useCalendar";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { useAppStore } from "../../stores/appStore";
import { CALENDAR_COLORS } from "../../lib/calendar/palette";
import { DEFAULT_REFRESH_MINUTES, looksLikeFeedLink, REFRESH_CHOICES, refreshLabelKey } from "../../lib/calendar/subscriptions";
import i18n from "../../lib/i18n";
import { Select } from "../ui/Select";

export type SubscribeTarget = { mode: "subscribe" } | { mode: "change"; calendar: Calendar };

interface SubscribeDialogProps {
  target: SubscribeTarget;
  onClose: () => void;
}

const INPUT = "w-full h-9 px-3 rounded-lg border border-border bg-bg-secondary text-sm text-text outline-none focus:border-accent";

export function SubscribeDialog({ target, onClose }: SubscribeDialogProps) {
  const { t } = useTranslation();
  const ref = useFocusTrap<HTMLDivElement>(true);
  const addToast = useAppStore((s) => s.addToast);
  const { data: calendars = [] } = useCalendars();
  const subscribe = useSubscribeCalendar();
  const changeLink = useUpdateSubscriptionUrl();
  const [url, setUrl] = useState("");
  const [color, setColor] = useState(() => CALENDAR_COLORS[calendars.length % CALENDAR_COLORS.length]);
  const [refresh, setRefresh] = useState<number>(DEFAULT_REFRESH_MINUTES);
  const [error, setError] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const busy = subscribe.isPending || changeLink.isPending;
  const changing = target.mode === "change";

  useEffect(() => {
    if (target.mode !== "change") return;
    getSubscriptionUrl(target.calendar.id).then(setUrl).catch(() => {});
  }, [target]);

  useEffect(() => {
    // Capture phase: the calendar view behind must not react to this Escape. An open
    // interval list closes itself first.
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      if ((e.target as Element | null)?.closest?.('[role="listbox"]')) return;
      e.stopPropagation();
      if (!busy) onClose();
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  async function submit() {
    if (busy || !looksLikeFeedLink(url)) return;
    setError(null);
    try {
      if (target.mode === "change") {
        await changeLink.mutateAsync({ id: target.calendar.id, url });
        addToast("success", t("calendar.subscribe.linkSaved"));
      } else {
        const result = await subscribe.mutateAsync({ url, color, refreshMinutes: refresh });
        addToast("success", t("calendar.subscribe.done", { name: result.calendar.name, events: t("calendar.import.events", { count: result.events }) }));
      }
      onClose();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(i18n.exists(message) ? t(message) : t("errors.generic"));
    }
  }

  return (
    <div
      className="fixed inset-0 z-[60] modal-backdrop grid place-items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="calendar-subscribe-title"
        className="w-[420px] max-w-[92vw] rounded-xl border border-border bg-surface p-5 shadow-2xl modal-panel-enter"
      >
        <div className="mb-4 flex items-center gap-2">
          <Rss className="h-4 w-4 text-accent" />
          <h2 id="calendar-subscribe-title" className="text-sm font-semibold text-text">
            {t(changing ? "calendar.subscribe.changeTitle" : "calendar.subscribe.title")}
          </h2>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void submit();
          }}
          className="space-y-4"
        >
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-text-secondary">{t("calendar.subscribe.link")}</span>
            <input
              autoFocus
              value={url}
              onChange={(e) => {
                setUrl(e.target.value);
                setError(null);
              }}
              placeholder={t("calendar.subscribe.linkPlaceholder")}
              spellCheck={false}
              className={INPUT}
            />
            {error && <span className="mt-1.5 block text-xs text-danger">{error}</span>}
          </label>

          {!changing && (
            <div className="flex items-end gap-4">
              <div>
                <span className="mb-1 block text-xs font-medium text-text-secondary">{t("calendar.subscribe.color")}</span>
                <div className="flex h-9 items-center gap-1.5">
                  {CALENDAR_COLORS.map((c) => (
                    <button
                      key={c}
                      type="button"
                      aria-label={c}
                      aria-pressed={c === color}
                      onClick={() => setColor(c)}
                      className={`h-5 w-5 rounded-full outline-none ring-offset-2 ring-offset-surface focus-visible:ring-2 focus-visible:ring-accent ${c === color ? "ring-2 ring-text-tertiary" : ""}`}
                      style={{ background: c }}
                    />
                  ))}
                </div>
              </div>
              <div className="min-w-0 flex-1">
                <span className="mb-1 block text-xs font-medium text-text-secondary">{t("calendar.subscribe.refresh")}</span>
                <Select
                  value={String(refresh)}
                  options={REFRESH_CHOICES.map((m) => ({ value: String(m), label: t(refreshLabelKey(m)) }))}
                  onChange={(v) => setRefresh(Number(v))}
                  ariaLabel={t("calendar.subscribe.refresh")}
                />
              </div>
            </div>
          )}

          <div>
            <button
              type="button"
              aria-expanded={helpOpen}
              onClick={() => setHelpOpen((o) => !o)}
              className="flex items-center gap-1 text-xs text-accent hover:underline"
            >
              <ChevronDown className={`h-3.5 w-3.5 transition-transform ${helpOpen ? "" : "-rotate-90"}`} />
              {t("calendar.subscribe.help")}
            </button>
            {helpOpen && (
              <ul className="mt-2 space-y-1.5 rounded-lg bg-bg-secondary px-3 py-2.5 text-xs text-text-secondary">
                <li>{t("calendar.subscribe.helpGoogle")}</li>
                <li>{t("calendar.subscribe.helpIcloud")}</li>
                <li>{t("calendar.subscribe.helpOutlook")}</li>
              </ul>
            )}
          </div>

          <p className="text-xs text-text-tertiary">{t("calendar.subscribe.privacy")}</p>

          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} disabled={busy} className="rounded-lg px-3 py-1.5 text-xs text-text-secondary hover:bg-hover disabled:opacity-50">
              {t("common.cancel")}
            </button>
            <button
              type="submit"
              disabled={busy || !looksLikeFeedLink(url)}
              className="rounded-lg bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent/90 disabled:opacity-50"
            >
              {busy ? t("common.pleaseWait") : t(changing ? "calendar.subscribe.save" : "calendar.subscribe.submit")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
