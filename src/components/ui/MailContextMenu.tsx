import { Reply, ReplyAll, Forward, Star, StarOff, Mail as MailIcon, MailOpen, Archive, Trash2, Pin, PinOff, Clock, FolderInput, ClipboardList, ClipboardPlus } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Mail, Folder } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { ContextMenu } from "./ContextMenu";
import type { MenuEntry } from "../../lib/menuModel";

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
  onCreateTask: (mail: Mail) => void;
  onAddToTask: (mail: Mail) => void;
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
  onCreateTask,
  onAddToTask,
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
  const hasFeature = useAppStore((s) => s.hasFeature);

  const bulkMode = !!onBulkAction && (selectedCount ?? 0) >= 2;

  const snooze = (apply: (until: string) => void): MenuEntry[] =>
    getSnoozePresets(t).map((p, i) => ({ kind: "item", id: `snooze-${i}`, label: p.label, icon: <Clock className="w-4 h-4" />, onSelect: () => apply(p.getDate()) }));

  const single: MenuEntry[] = [
    { kind: "item", id: "reply", label: t("mailDetail.reply"), icon: <Reply className="w-4 h-4" />, onSelect: () => onReply(mail) },
    { kind: "item", id: "replyAll", label: t("compose.replyAll"), icon: <ReplyAll className="w-4 h-4" />, onSelect: () => onReplyAll(mail) },
    { kind: "item", id: "forward", label: t("mailDetail.forward"), icon: <Forward className="w-4 h-4" />, onSelect: () => onForward(mail) },
    { kind: "separator" },
    { kind: "item", id: "createTask", label: t("tasks.createFromMail"), icon: <ClipboardList className="w-4 h-4" />, onSelect: () => onCreateTask(mail) },
    { kind: "item", id: "addToTask", label: t("tasks.addToTask"), icon: <ClipboardPlus className="w-4 h-4" />, onSelect: () => onAddToTask(mail) },
    { kind: "separator" },
    { kind: "item", id: "star", label: mail.is_starred ? t("mailDetail.unstar") : t("mailDetail.star"), icon: mail.is_starred ? <StarOff className="w-4 h-4" /> : <Star className="w-4 h-4" />, onSelect: () => onToggleStar(mail) },
    ...(onTogglePin ? [{ kind: "item" as const, id: "pin", label: mail.is_pinned ? t("mailDetail.unpin") : t("mailDetail.pin"), icon: mail.is_pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />, onSelect: () => onTogglePin(mail) }] : []),
    { kind: "item", id: "read", label: mail.is_read ? t("mailDetail.markUnread") : t("mailDetail.markRead"), icon: mail.is_read ? <MailIcon className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />, onSelect: () => onToggleRead(mail) },
    ...(onSnooze && hasFeature("snooze") ? [{ kind: "item" as const, id: "snooze", label: t("snooze.snooze"), icon: <Clock className="w-4 h-4" />, submenu: snooze((until) => onSnooze(mail, until)) }] : []),
    { kind: "separator" },
    { kind: "item", id: "archive", label: t("mailDetail.archive"), icon: <Archive className="w-4 h-4" />, onSelect: () => onArchive(mail) },
    { kind: "item", id: "trash", label: t("mailDetail.trash"), icon: <Trash2 className="w-4 h-4" />, danger: true, onSelect: () => onTrash(mail) },
  ];

  const bulk: MenuEntry[] = [
    { kind: "header", label: `${selectedCount} ${t("mailList.selectedSuffix")}` },
    { kind: "separator" },
    { kind: "item", id: "markRead", label: t("mailDetail.markRead"), icon: <MailOpen className="w-4 h-4" />, onSelect: () => onBulkAction!("mark_read") },
    { kind: "item", id: "markUnread", label: t("mailDetail.markUnread"), icon: <MailIcon className="w-4 h-4" />, onSelect: () => onBulkAction!("mark_unread") },
    { kind: "separator" },
    { kind: "item", id: "star", label: t("mailDetail.star"), icon: <Star className="w-4 h-4" />, onSelect: () => onBulkAction!("star") },
    { kind: "item", id: "unstar", label: t("mailDetail.unstar"), icon: <StarOff className="w-4 h-4" />, onSelect: () => onBulkAction!("unstar") },
    ...(onBulkSnooze && hasFeature("snooze") ? [{ kind: "item" as const, id: "snooze", label: t("snooze.snooze"), icon: <Clock className="w-4 h-4" />, submenu: snooze(onBulkSnooze) }] : []),
    ...(onBulkMove && moveFolders && moveFolders.length > 0 ? [{ kind: "item" as const, id: "move", label: t("rules.moveToFolder"), icon: <FolderInput className="w-4 h-4" />, submenu: moveFolders.map((f) => ({ kind: "item" as const, id: `move-${f.id}`, label: f.name, icon: <FolderInput className="w-4 h-4" />, onSelect: () => onBulkMove(f.id) })) }] : []),
    { kind: "separator" },
    { kind: "item", id: "archive", label: t("mailDetail.archive"), icon: <Archive className="w-4 h-4" />, onSelect: () => onBulkAction!("archive") },
    { kind: "item", id: "trash", label: t("mailDetail.trash"), icon: <Trash2 className="w-4 h-4" />, danger: true, onSelect: () => onBulkAction!("trash") },
  ];

  return <ContextMenu entries={bulkMode ? bulk : single} x={x} y={y} onClose={onClose} />;
}
