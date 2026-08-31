import { Archive, Trash2, MailOpen, Mail, X } from "lucide-react";
import { motion, AnimatePresence, useReducedMotion } from "motion/react";
import { useTranslation } from "react-i18next";

interface BatchActionBarProps {
  count: number;
  onArchive: () => void;
  onTrash: () => void;
  onMarkRead: () => void;
  onMarkUnread: () => void;
  onClear: () => void;
}

/**
 * Floating actions for the current multi-selection. Batch operations were
 * only reachable via right-click and shortcuts; this makes them visible.
 */
export function BatchActionBar({ count, onArchive, onTrash, onMarkRead, onMarkUnread, onClear }: BatchActionBarProps) {
  const { t } = useTranslation();
  const reduce = useReducedMotion();

  const actionCls =
    "flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-text-secondary hover:bg-hover hover:text-text transition-colors";

  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          initial={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }}
          animate={reduce ? { opacity: 1 } : { opacity: 1, y: 0, scale: 1 }}
          exit={reduce ? { opacity: 0 } : { opacity: 0, y: 24, scale: 0.96 }}
          transition={{ type: "spring", stiffness: 500, damping: 32 }}
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 flex items-center gap-1 pl-3 pr-1.5 py-1.5 rounded-xl bg-surface border border-border shadow-lg"
          role="toolbar"
          aria-label={t("mailList.selectedCount", { count })}
        >
          <span className="text-xs font-semibold text-text tabular-nums whitespace-nowrap mr-1">
            {t("mailList.selectedCount", { count })}
          </span>
          <button onClick={onArchive} className={actionCls} title={t("mailList.batchArchive")}>
            <Archive className="w-3.5 h-3.5" />
            {t("mailList.batchArchive")}
          </button>
          <button onClick={onTrash} className={`${actionCls} hover:text-danger`} title={t("mailList.batchTrash")}>
            <Trash2 className="w-3.5 h-3.5" />
            {t("mailList.batchTrash")}
          </button>
          <button onClick={onMarkRead} className={actionCls} title={t("mailList.batchMarkRead")}>
            <MailOpen className="w-3.5 h-3.5" />
          </button>
          <button onClick={onMarkUnread} className={actionCls} title={t("mailList.batchMarkUnread")}>
            <Mail className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={onClear}
            className="p-1.5 rounded-lg text-text-tertiary hover:bg-hover hover:text-text transition-colors"
            title={t("mailList.batchClear")}
            aria-label={t("mailList.batchClear")}
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
