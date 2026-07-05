import { useState, useEffect, useRef, useCallback } from "react";
import { createPortal } from "react-dom";
import { Reply, ReplyAll, Forward, Star, StarOff, Mail as MailIcon, MailOpen, Archive, Trash2, Pin, PinOff, Clock, ChevronRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Mail } from "../../types";
import { useAppStore } from "../../stores/appStore";

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
}: MailContextMenuProps) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [showSnoozeMenu, setShowSnoozeMenu] = useState(false);
  const hasFeature = useAppStore((s) => s.hasFeature);

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

  const items: ({ icon: React.ReactNode; label: string; action: () => void; danger?: boolean; submenu?: boolean } | { separator: true })[] = [
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
      action: () => setShowSnoozeMenu(true),
      submenu: true,
    }] : []),
    { separator: true },
    { icon: <Archive className="w-4 h-4" />, label: t("mailDetail.archive"), action: () => onArchive(mail) },
    { icon: <Trash2 className="w-4 h-4 text-danger" />, label: t("mailDetail.trash"), action: () => onTrash(mail), danger: true },
  ];

  const snoozePresets = getSnoozePresets(t);

  return createPortal(
    <div
      ref={menuRef}
      className="fixed z-9999 min-w-[180px] bg-surface rounded-lg shadow-lg border border-border py-1 animate-in fade-in zoom-in-95 duration-100"
      style={{ left: pos.left, top: pos.top }}
    >
      {showSnoozeMenu ? (
        <>
          <button
            onClick={() => setShowSnoozeMenu(false)}
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
                onSnooze?.(mail, preset.getDate());
                onClose();
              }}
              className="w-full flex items-center gap-3 px-3 py-1.5 text-sm text-text hover:bg-hover transition-colors"
            >
              <span className="text-text-tertiary"><Clock className="w-4 h-4" /></span>
              <span>{preset.label}</span>
            </button>
          ))}
        </>
      ) : (
        items.map((item, i) =>
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
        )
      )}
    </div>,
    document.body
  );
}
