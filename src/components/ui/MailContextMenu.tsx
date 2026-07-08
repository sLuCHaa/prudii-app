import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Reply, ReplyAll, Forward, Star, StarOff, Mail as MailIcon, MailOpen, Archive, Trash2, Pin, PinOff, Clock, ChevronRight, FolderInput } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Mail, Folder } from "../../types";
import { useAppStore } from "../../stores/appStore";

export type BulkMailAction = "mark_read" | "mark_unread" | "star" | "unstar" | "archive" | "trash";

interface MailContextMenuProps {
  mail: Mail;
  x: number;
  y: number;
  onClose: () => void;
  onReply: (mail: Mail) => void;
  onReplyAll: (mail: Mail) => void;
  onForward: (mail: Mail) => void;
  onToggleStar: (mail: Mail) => void;
  onToggleRead: (mail: Mail) => void;
  onArchive: (mail: Mail) => void;
  onTrash: (mail: Mail) => void;
  onTogglePin?: (mail: Mail) => void;
  onSnooze?: (mail: Mail, until: string) => void;
  /** Bulk mode: number of selected mails; menu switches to bulk items when >= 2 and onBulkAction is set. */
  selectedCount?: number;
  onBulkAction?: (action: BulkMailAction) => void;
  onBulkSnooze?: (until: string) => void;
  /** Move all selected mails to a folder; only offered when moveFolders is non-empty. */
  onBulkMove?: (destFolderId: string) => void;
  /** Move targets (folders of the selection's common account). */
  moveFolders?: Folder[];
}

function getSnoozePresets(t: (key: string) => string): { label: string; getDate: () => string }[] {
  return [
    {
      label: t("snooze.in1Hour"),
      getDate: () => {
        const d = new Date();
        d.setHours(d.getHours() + 1);
        return d.toISOString().slice(0, 19).replace("T", " ");
      },
    },
    {
      label: t("snooze.in3Hours"),
      getDate: () => {
        const d = new Date();
        d.setHours(d.getHours() + 3);
        return d.toISOString().slice(0, 19).replace("T", " ");
      },
    },
    {
      label: t("snooze.tomorrowMorning"),
      getDate: () => {
        const d = new Date();
        d.setDate(d.getDate() + 1);
        d.setHours(9, 0, 0, 0);
        return d.toISOString().slice(0, 19).replace("T", " ");
      },
    },
    {
      label: t("snooze.nextMonday"),
      getDate: () => {
        const d = new Date();
        const dayOfWeek = d.getDay();
        const daysUntilMonday = dayOfWeek === 0 ? 1 : 8 - dayOfWeek;
        d.setDate(d.getDate() + daysUntilMonday);
        d.setHours(9, 0, 0, 0);
        return d.toISOString().slice(0, 19).replace("T", " ");
      },
    },
  ];
}

export function MailContextMenu({
  mail,
  x,
  y,
  onClose,
  onReply,
  onReplyAll,
  onForward,
  onToggleStar,
  onToggleRead,
  onArchive,
  onTrash,
  onTogglePin,
  onSnooze,
  selectedCount,
  onBulkAction,
  onBulkSnooze,
  onBulkMove,
  moveFolders,
}: MailContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [activeSubmenu, setActiveSubmenu] = useState<"snooze" | "move" | null>(null);
  const hasFeature = useAppStore((s) => s.hasFeature);

  const bulkMode = !!onBulkAction && (selectedCount ?? 0) >= 2;

  const adjustedPosition = useCallback(() => {
    const menuWidth = 200;
    const menuHeight = 280;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    return {
      left: x + menuWidth > vw ? vw - menuWidth - 8 : x,
      top: y + menuHeight > vh ? vh - menuHeight - 8 : y,
    };
  }, [x, y]);

  const pos = adjustedPosition();

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [onClose]);

  const singleItems: ({ icon: React.ReactNode; label: string; action: () => void; danger?: boolean; submenu?: boolean } | { separator: true })[] = [
    { icon: <Reply className="w-4 h-4" />, label: t("mailDetail.reply"), action: () => onReply(mail) },
    { icon: <ReplyAll className="w-4 h-4" />, label: t("compose.replyAll"), action: () => onReplyAll(mail) },
    { icon: <Forward className="w-4 h-4" />, label: t("mailDetail.forward"), action: () => onForward(mail) },
    { separator: true },
    {
      icon: mail.is_starred ? <StarOff className="w-4 h-4" /> : <Star className="w-4 h-4" />,
      label: mail.is_starred ? t("mailDetail.unstar") : t("mailDetail.star"),
      action: () => onToggleStar(mail),
    },
    ...(onTogglePin ? [{
      icon: mail.is_pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />,
      label: mail.is_pinned ? t("mailDetail.unpin") : t("mailDetail.pin"),
      action: () => onTogglePin(mail),
    }] : []),
    {
      icon: mail.is_read ? <MailIcon className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />,
      label: mail.is_read ? t("mailDetail.markUnread") : t("mailDetail.markRead"),
      action: () => onToggleRead(mail),
    },
    ...(onSnooze && hasFeature("snooze") ? [{
      icon: <Clock className="w-4 h-4" />,
      label: t("snooze.snooze"),
      action: () => setActiveSubmenu("snooze"),
      submenu: true,
    }] : []),
    { separator: true },
    { icon: <Archive className="w-4 h-4" />, label: t("mailDetail.archive"), action: () => onArchive(mail) },
    { icon: <Trash2 className="w-4 h-4 text-danger" />, label: t("mailDetail.trash"), action: () => onTrash(mail), danger: true },
  ];

  const bulkItems: typeof singleItems = [
    { icon: <MailOpen className="w-4 h-4" />, label: t("mailDetail.markRead"), action: () => onBulkAction!("mark_read") },
    { icon: <MailIcon className="w-4 h-4" />, label: t("mailDetail.markUnread"), action: () => onBulkAction!("mark_unread") },
    { separator: true },
    { icon: <Star className="w-4 h-4" />, label: t("mailDetail.star"), action: () => onBulkAction!("star") },
    { icon: <StarOff className="w-4 h-4" />, label: t("mailDetail.unstar"), action: () => onBulkAction!("unstar") },
    ...(onBulkSnooze && hasFeature("snooze") ? [{
      icon: <Clock className="w-4 h-4" />,
      label: t("snooze.snooze"),
      action: () => setActiveSubmenu("snooze"),
      submenu: true,
    }] : []),
    ...(onBulkMove && moveFolders && moveFolders.length > 0 ? [{
      icon: <FolderInput className="w-4 h-4" />,
      label: t("rules.moveToFolder"),
      action: () => setActiveSubmenu("move"),
      submenu: true,
    }] : []),
    { separator: true },
    { icon: <Archive className="w-4 h-4" />, label: t("mailDetail.archive"), action: () => onBulkAction!("archive") },
    { icon: <Trash2 className="w-4 h-4 text-danger" />, label: t("mailDetail.trash"), action: () => onBulkAction!("trash"), danger: true },
  ];

  const items = bulkMode ? bulkItems : singleItems;

  const snoozePresets = getSnoozePresets(t);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-9999 min-w-[180px] bg-surface rounded-lg shadow-lg border border-border py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{ left: pos.left, top: pos.top }}
    >
      {activeSubmenu === "snooze" ? (
        <>
          <button
            onClick={() => setActiveSubmenu(null)}
            className="w-full flex items-center gap-3 px-3 py-1.5 text-sm text-text hover:bg-hover transition-colors"
          >
            <span className="text-text-tertiary"><ChevronRight className="w-4 h-4 rotate-180" /></span>
            <span className="font-medium">{t("snooze.snooze")}</span>
          </button>
          <div className="my-1 border-t border-border" />
          {snoozePresets.map((preset, i) => (
            <button
              key={i}
              onClick={() => {
                if (bulkMode) onBulkSnooze?.(preset.getDate());
                else onSnooze?.(mail, preset.getDate());
                onClose();
              }}
              className="w-full flex items-center gap-3 px-3 py-1.5 text-sm text-text hover:bg-hover transition-colors"
            >
              <span className="text-text-tertiary"><Clock className="w-4 h-4" /></span>
              <span>{preset.label}</span>
            </button>
          ))}
        </>
      ) : activeSubmenu === "move" ? (
        <>
          <button
            onClick={() => setActiveSubmenu(null)}
            className="w-full flex items-center gap-3 px-3 py-1.5 text-sm text-text hover:bg-hover transition-colors"
          >
            <span className="text-text-tertiary"><ChevronRight className="w-4 h-4 rotate-180" /></span>
            <span className="font-medium">{t("rules.moveToFolder")}</span>
          </button>
          <div className="my-1 border-t border-border" />
          {(moveFolders ?? []).map((f) => (
            <button
              key={f.id}
              onClick={() => {
                onBulkMove?.(f.id);
                onClose();
              }}
              className="w-full flex items-center gap-3 px-3 py-1.5 text-sm text-text hover:bg-hover transition-colors"
            >
              <span className="text-text-tertiary"><FolderInput className="w-4 h-4" /></span>
              <span className="flex-1 text-left truncate">{f.name}</span>
            </button>
          ))}
        </>
      ) : (
        <>
          {bulkMode && (
            <>
              <div className="px-3 py-1.5 text-xs font-semibold text-text-tertiary tabular-nums">
                {selectedCount} {t("mailList.selectedSuffix")}
              </div>
              <div className="my-1 border-t border-border" />
            </>
          )}
          {items.map((item, i) =>
            "separator" in item ? (
              <div key={i} className="my-1 border-t border-border" />
            ) : (
              <button
                key={i}
                onClick={() => {
                  item.action();
                  if (!item.submenu) onClose();
                }}
                className={`w-full flex items-center gap-3 px-3 py-1.5 text-sm transition-colors hover:bg-hover ${
                  item.danger ? "text-danger" : "text-text"
                }`}
              >
                <span className="text-text-tertiary">{item.icon}</span>
                <span className="flex-1 text-left">{item.label}</span>
                {item.submenu && <ChevronRight className="w-3 h-3 text-text-tertiary" />}
              </button>
            )
          )}
        </>
      )}
    </div>,
    document.body
  );
}
