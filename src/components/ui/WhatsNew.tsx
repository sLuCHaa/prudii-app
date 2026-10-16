import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { getVersion } from "@tauri-apps/api/app";
import { CalendarDays, ListChecks, MailCheck, Rss, Sparkles, type LucideIcon } from "lucide-react";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Button } from "./Button";
import { displayVersion, pendingRelease, readSeen, RELEASES, SEEN_KEY, type WhatsNewIcon, type WhatsNewRelease, type WhatsNewTone } from "../../lib/whatsNew";

const ICONS: Record<WhatsNewIcon, LucideIcon> = { calendar: CalendarDays, mail: MailCheck, rss: Rss, tasks: ListChecks };

const TONES: Record<WhatsNewTone, string> = {
  blue: "bg-blue-500/12 text-blue-500",
  green: "bg-emerald-500/14 text-emerald-500",
  amber: "bg-amber-500/16 text-amber-600",
  violet: "bg-violet-500/14 text-violet-500",
};

function storage(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function writeSeen(version: string) {
  try {
    storage()?.setItem(SEEN_KEY, version);
  } catch {
    // A blocked store only means the window may show once more.
  }
}

export function WhatsNew({ hasAccounts }: { hasAccounts: boolean }) {
  const [shown, setShown] = useState<{ release: WhatsNewRelease; current: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    getVersion()
      .then((current) => {
        if (cancelled) return;
        const { release, store } = pendingRelease(current, readSeen(storage()), hasAccounts, RELEASES);
        if (store) writeSeen(store);
        if (release) setShown({ release, current });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // Decided once per start; adding the first account later must not open it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = useCallback(() => {
    if (shown) writeSeen(shown.current);
    setShown(null);
  }, [shown]);

  return shown ? <WhatsNewDialog release={shown.release} onClose={close} /> : null;
}

function WhatsNewDialog({ release, onClose }: { release: WhatsNewRelease; onClose: () => void }) {
  const { t } = useTranslation();
  const trapRef = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="fixed inset-0 modal-backdrop flex items-center justify-center z-100" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="whats-new-title"
        className="modal-panel-enter mx-4 w-full max-w-sm overflow-hidden rounded-2xl border border-border bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-3 px-6 pt-6">
          <div
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl text-white"
            style={{ background: "linear-gradient(135deg, var(--color-accent), #8b5cf6)" }}
          >
            <Sparkles className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <h2 id="whats-new-title" className="text-lg font-semibold text-text">
              {t("whatsNew.title", { version: displayVersion(release.version) })}
            </h2>
            <p className="text-xs text-text-secondary">{t("whatsNew.subtitle")}</p>
          </div>
        </div>
        <ul className="flex flex-col gap-3.5 px-6 pt-5">
          {release.items.map((item) => {
            const Icon = ICONS[item.icon];
            return (
              <li key={item.key} className="flex gap-3">
                <div className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] ${TONES[item.tone]}`}>
                  <Icon className="h-4.5 w-4.5" />
                </div>
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-text">{t(`${item.key}.title`)}</p>
                  <p className="text-xs leading-relaxed text-text-secondary">{t(`${item.key}.text`)}</p>
                </div>
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end px-6 pb-6 pt-5">
          <Button variant="primary" onClick={onClose}>
            {t("whatsNew.done")}
          </Button>
        </div>
      </div>
    </div>
  );
}
