import { useState } from "react";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { TaskMailLink } from "../../types";
import { useTaskLinks } from "../../hooks/useTasks";
import { useAppStore } from "../../stores/appStore";
import { getMail } from "../../lib/tauri";
import { formatMailDate } from "../../lib/dateUtils";
import { GradientAvatar } from "../motion/GradientAvatar";
import { TaskSectionHead } from "./TaskSectionHead";

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
      // Without the folder the mail list has nothing to query and the sidebar's
      // "no folder selected" effect overwrites the selection right away.
      openMailById(link.account_id, link.mail_id, mail.folder_id);
    } catch {
      addToast("error", t("tasks.mailGone"));
    } finally {
      setNavigatingId(null);
    }
  }

  return (
    <div>
      <TaskSectionHead title={t("tasks.linkedMails")} count={links.length} />
      <div className="grid gap-1.5">
        {links.map((link) => (
          <div
            key={link.mail_id}
            className="grid grid-cols-[32px_1fr_auto] items-center gap-2.5 px-2.5 py-2 rounded-xl border border-border-light bg-surface hover:border-border hover:bg-bg-secondary transition-colors group"
          >
            <GradientAvatar email={link.from_email} name={link.from_name} size={32} />
            <button
              type="button"
              onClick={() => goToMail(link)}
              disabled={navigatingId === link.mail_id}
              title={t("tasks.openMail")}
              className="min-w-0 text-left disabled:opacity-50"
            >
              <div className="truncate text-xs text-text-secondary">{link.from_name || link.from_email}</div>
              <div className="truncate text-[13.5px] font-medium text-text">{link.subject || t("compose.noSubject")}</div>
            </button>
            <div className="flex items-center gap-1.5">
              {link.mail_date && (
                <span className="text-[11.5px] text-text-tertiary tabular-nums">{formatMailDate(link.mail_date, use24h)}</span>
              )}
              <button
                type="button"
                onClick={() => unlink.mutate(link.mail_id)}
                aria-label={t("tasks.unlink")}
                title={t("tasks.unlink")}
                className="w-6 h-6 grid place-items-center rounded-md opacity-0 group-hover:opacity-100 text-text-tertiary hover:bg-hover hover:text-danger transition-colors"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
