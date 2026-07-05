import { useState, useRef, useEffect } from "react";
import { ShieldCheck } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { TrackerInfo } from "../../lib/sanitize";

interface TrackingIndicatorProps {
  trackers: TrackerInfo[];
}

const TYPE_LABEL_KEYS: Record<TrackerInfo["type"], string> = {
  pixel: "tracking.pixelTracker",
  tracking_domain: "tracking.knownTracker",
  hidden: "tracking.hiddenTracker",
};

export function TrackingIndicator({ trackers }: TrackingIndicatorProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  const hasTrackers = trackers.length > 0;

  const uniqueDomains = new Map<string, TrackerInfo>();
  for (const tracker of trackers) {
    if (!uniqueDomains.has(tracker.domain)) {
      uniqueDomains.set(tracker.domain, tracker);
    }
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={hasTrackers ? () => setOpen(!open) : undefined}
        className={`flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium transition-colors text-success ${
          hasTrackers ? "hover:bg-success/10 cursor-pointer" : "cursor-default"
        }`}
        title={t("tracking.title")}
      >
        <ShieldCheck className="w-3.5 h-3.5" />
        <span>
          {hasTrackers
            ? t("tracking.trackersBlocked", { count: trackers.length })
            : t("tracking.noTrackers")}
        </span>
      </button>

      {open && hasTrackers && (
        <div className="absolute top-full right-0 mt-1 w-72 bg-surface border border-border rounded-lg shadow-lg z-50 overflow-hidden">
          <div className="px-3 py-2 border-b border-border bg-bg-secondary">
            <div className="flex items-center gap-2">
              <ShieldCheck className="w-4 h-4 text-success" />
              <span className="text-xs font-semibold text-text">
                {t("tracking.title")}
              </span>
            </div>
          </div>
          <div className="max-h-48 overflow-y-auto scrollbar-thin">
            {[...uniqueDomains.entries()].map(([domain, info]) => (
              <div
                key={domain}
                className="px-3 py-2 border-b border-border-light last:border-b-0"
              >
                <div className="text-xs font-medium text-text truncate">{domain}</div>
                <div className="text-[11px] text-text-tertiary">
                  {t(TYPE_LABEL_KEYS[info.type])}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
