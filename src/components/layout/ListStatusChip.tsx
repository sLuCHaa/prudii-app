import { useTranslation } from "react-i18next";
import type { Unsubscription } from "../../types";
import { statusActions, statusLabel } from "../../lib/unsubscribeStatus";

interface ListStatusChipProps {
  sub: Unsubscription;
  busy: boolean;
  onAction: (action: "retry" | "allow", id: string) => void;
}

export function ListStatusChip({ sub, busy, onAction }: ListStatusChipProps) {
  const { t, i18n } = useTranslation();
  const formatDate = (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { day: "numeric", month: "short" });
  const label = statusLabel(sub, formatDate);
  const warn = sub.status === "still_sending";

  return (
    <div className={`flex items-center gap-2 px-2.5 py-1 rounded-lg text-xs ${warn ? "bg-warning/10 text-warning" : "bg-hover text-text-secondary"}`}>
      <span className="truncate max-w-64">{t(label.key, label.options)}</span>
      {statusActions(sub).map((action) => (
        <button
          key={action}
          type="button"
          disabled={busy}
          onClick={() => onAction(action, sub.id)}
          className="font-medium text-accent hover:underline disabled:opacity-50 shrink-0"
        >
          {t(action === "retry" ? "unsubscribe.retry" : "unsubscribe.allowAgain")}
        </button>
      ))}
    </div>
  );
}
