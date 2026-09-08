import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Mail as MailIcon, X } from "lucide-react";
import type { TaskMailLink } from "../../types";
import { useTaskLinks } from "../../hooks/useTasks";
import { useAppStore } from "../../stores/appStore";
import { getMail } from "../../lib/tauri";
import { formatMailDate } from "../../lib/dateUtils";

interface LinkedMailsProps {
  taskId: string;
  links: TaskMailLink[];
}

export function LinkedMails({ taskId, links }: LinkedMailsProps) {
  const { t } = useTranslation();
  const { unlink } = useTaskLinks(taskId);
  const openMailById = useAppStore((s) => s.openMailById);
  const addToast = useAppStore((s) => s.addToast);
  const use24h = useAppStore((s) => s.appSettings.use_24h_clock);
  const [navigatingId, setNavigatingId] = useState<string | null>(null);

  if (links.length === 0) return null;

  async function goToMail(link: TaskMailLink) {
    setNavigatingId(link.mail_id);
    try {
      const mail = await getMail(link.mail_id);
      if (!mail) {
        addToast("error", t("tasks.mailGone"));
        return;
      }
      openMailById(link.account_id, link.mail_id);
    } finally {
      setNavigatingId(null);
    }
  }

  return (
    <div>
      <h3 className="text-xs font-semibold uppercase tracking-wide text-text-secondary mb-2">{t("tasks.linkedMails")}</h3>
      <div className="space-y-1">
        {links.map((link) => (
          <div
            key={link.mail_id}
            className="flex items-center gap-2 px-2 py-1.5 rounded-lg border border-border hover:bg-hover transition-colors group text-xs"
          >
            <MailIcon className="w-3.5 h-3.5 text-text-tertiary shrink-0" />
            <button
              type="button"
              onClick={() => goToMail(link)}
              disabled={navigatingId === link.mail_id}
              title={t("tasks.openMail")}
              className="flex-1 min-w-0 text-left disabled:opacity-50"
            >
              <div className="truncate text-text">{link.subject || t("compose.noSubject")}</div>
              <div className="truncate text-text-tertiary">
                {link.from_name || link.from_email}
                {link.mail_date && ` · ${formatMailDate(link.mail_date, use24h)}`}
              </div>
            </button>
            <button
              type="button"
              onClick={() => unlink.mutate(link.mail_id)}
              aria-label={t("tasks.unlink")}
              title={t("tasks.unlink")}
              className="shrink-0 p-1 rounded hover:bg-hover transition-colors opacity-0 group-hover:opacity-100 text-text-tertiary hover:text-danger"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
