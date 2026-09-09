import { Reply, ReplyAll, Forward, Star, StarOff, Mail as MailIcon, MailOpen, Archive, Trash2, Pin, PinOff, Clock, FolderInput, ClipboardList, ClipboardPlus, Flag, FlagOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MAIL_FLAG_COLORS, type Mail, type Folder, type MailFlag } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { ContextMenu } from "./ContextMenu";
import type { MenuEntry } from "../../lib/menuModel";
import { FLAG_ORDER, bulkFlagAction, commonFlags } from "../../lib/mailFlags";
import { SNOOZE_PRESETS, toSnoozeStamp } from "../../lib/snooze";

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
  onToggleFlag?: (mail: Mail, flag: MailFlag) => void;
  onClearFlags?: (mail: Mail) => void;
  /** Bulk mode: number of selected mails; menu switches to bulk items when >= 2 and onBulkAction is set. */
  selectedCount?: number;
  onBulkAction?: (action: BulkMailAction) => void;
  /** Bulk mode: each selected mail's flags, so a colour they all share renders checked. */
  selectedFlags?: string[][];
  onBulkFlag?: (flag: MailFlag, action: "set" | "clear") => void;
  onBulkClearFlags?: () => void;
  onBulkSnooze?: (until: string) => void;
  /** Move all selected mails to a folder; only offered when moveFolders is non-empty. */
  onBulkMove?: (destFolderId: string) => void;
  /** Move this mail to a folder; only offered when moveFolders is non-empty. */
  onMove?: (mail: Mail, destFolderId: string) => void;
  /** Move targets: the folders of the target's own account, never the open one —
   *  a combined view lists mails from several accounts side by side. */
  moveFolders?: Folder[];
  /** Named above the move targets, so it is never a guess which account they belong to. */
  moveAccountLabel?: string;
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
  onToggleFlag,
  onClearFlags,
  selectedCount,
  onBulkAction,
  selectedFlags,
  onBulkFlag,
  onBulkClearFlags,
  onBulkSnooze,
  onBulkMove,
  onMove,
  moveFolders,
  moveAccountLabel,
}: MailContextMenuProps) {
  const { t } = useTranslation();
  const hasFeature = useAppStore((s) => s.hasFeature);

  const bulkMode = !!onBulkAction && (selectedCount ?? 0) >= 2;

  const snooze = (apply: (until: string) => void): MenuEntry[] =>
    SNOOZE_PRESETS.map((p) => ({
      kind: "item",
      id: `snooze-${p.id}`,
      label: t(p.labelKey),
      icon: <Clock className="w-4 h-4" />,
      onSelect: () => apply(toSnoozeStamp(p.at(new Date()))),
    }));

  const flagSubmenu = (active: MailFlag[], apply: (flag: MailFlag) => void, clear: () => void): MenuEntry[] => [
    ...FLAG_ORDER.map((flag): MenuEntry => ({
      kind: "item",
      id: `flag-${flag}`,
      label: t(MAIL_FLAG_COLORS[flag].nameKey),
      icon: <span className="w-3 h-3 rounded-full" style={{ backgroundColor: MAIL_FLAG_COLORS[flag].bg }} />,
      selected: active.includes(flag),
      onSelect: () => apply(flag),
    })),
    ...(active.length > 0
      ? [
          { kind: "separator" as const },
          { kind: "item" as const, id: "flagsClear", label: t("flags.clearAll"), icon: <FlagOff className="w-4 h-4" />, onSelect: clear },
        ]
      : []),
  ];

  // Standard folders read as they do in the sidebar; a custom folder keeps its own name.
  const folderLabel = (f: Folder) => t(`folder.types.${f.folder_type}`, { defaultValue: f.name });

  const moveSubmenu = (apply: (destFolderId: string) => void): MenuEntry[] => [
    ...(moveAccountLabel ? [{ kind: "header" as const, label: moveAccountLabel }] : []),
    ...(moveFolders ?? []).map((f): MenuEntry => ({
      kind: "item",
      id: `move-${f.id}`,
      label: folderLabel(f),
      icon: <FolderInput className="w-4 h-4" />,
      onSelect: () => apply(f.id),
    })),
  ];

  const hasMoveTargets = !!moveFolders && moveFolders.length > 0;

  const singleFlags = commonFlags([mail.flags ?? []]);
  const bulkFlags = commonFlags(selectedFlags ?? []);

  const single: MenuEntry[] = [
    { kind: "item", id: "reply", label: t("mailDetail.reply"), icon: <Reply className="w-4 h-4" />, onSelect: () => onReply(mail) },
    { kind: "item", id: "replyAll", label: t("compose.replyAll"), icon: <ReplyAll className="w-4 h-4" />, onSelect: () => onReplyAll(mail) },
    { kind: "item", id: "forward", label: t("mailDetail.forward"), icon: <Forward className="w-4 h-4" />, onSelect: () => onForward(mail) },
    { kind: "separator" },
    { kind: "item", id: "createTask", label: t("tasks.createFromMail"), icon: <ClipboardList className="w-4 h-4" />, onSelect: () => onCreateTask(mail) },
    { kind: "item", id: "addToTask", label: t("tasks.addToTask"), icon: <ClipboardPlus className="w-4 h-4" />, onSelect: () => onAddToTask(mail) },
    { kind: "separator" },
    { kind: "item", id: "star", label: mail.is_starred ? t("mailDetail.unstar") : t("mailDetail.star"), icon: mail.is_starred ? <StarOff className="w-4 h-4" /> : <Star className="w-4 h-4" />, onSelect: () => onToggleStar(mail) },
    ...(onToggleFlag
      ? [{
          kind: "item" as const,
          id: "flags",
          label: t("flags.title"),
          icon: <Flag className="w-4 h-4" />,
          submenu: flagSubmenu(
            singleFlags,
            (flag) => onToggleFlag(mail, flag),
            () => onClearFlags?.(mail),
          ),
        }]
      : []),
    ...(onTogglePin ? [{ kind: "item" as const, id: "pin", label: mail.is_pinned ? t("mailDetail.unpin") : t("mailDetail.pin"), icon: mail.is_pinned ? <PinOff className="w-4 h-4" /> : <Pin className="w-4 h-4" />, onSelect: () => onTogglePin(mail) }] : []),
    { kind: "item", id: "read", label: mail.is_read ? t("mailDetail.markUnread") : t("mailDetail.markRead"), icon: mail.is_read ? <MailIcon className="w-4 h-4" /> : <MailOpen className="w-4 h-4" />, onSelect: () => onToggleRead(mail) },
    ...(onSnooze && hasFeature("snooze") ? [{ kind: "item" as const, id: "snooze", label: t("snooze.snooze"), icon: <Clock className="w-4 h-4" />, submenu: snooze((until) => onSnooze(mail, until)) }] : []),
    { kind: "separator" },
    ...(onMove && hasMoveTargets
      ? [{
          kind: "item" as const,
          id: "move",
          label: t("rules.moveToFolder"),
          icon: <FolderInput className="w-4 h-4" />,
          submenu: moveSubmenu((destFolderId) => onMove(mail, destFolderId)),
        }]
      : []),
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
    ...(onBulkFlag
      ? [{
          kind: "item" as const,
          id: "flags",
          label: t("flags.title"),
          icon: <Flag className="w-4 h-4" />,
          submenu: flagSubmenu(
            bulkFlags,
            (flag) => onBulkFlag(flag, bulkFlagAction(selectedFlags ?? [], flag)),
            () => onBulkClearFlags?.(),
          ),
        }]
      : []),
    ...(onBulkSnooze && hasFeature("snooze") ? [{ kind: "item" as const, id: "snooze", label: t("snooze.snooze"), icon: <Clock className="w-4 h-4" />, submenu: snooze(onBulkSnooze) }] : []),
    ...(onBulkMove && hasMoveTargets
      ? [{
          kind: "item" as const,
          id: "move",
          label: t("rules.moveToFolder"),
          icon: <FolderInput className="w-4 h-4" />,
          submenu: moveSubmenu(onBulkMove),
        }]
      : []),
    { kind: "separator" },
    { kind: "item", id: "archive", label: t("mailDetail.archive"), icon: <Archive className="w-4 h-4" />, onSelect: () => onBulkAction!("archive") },
    { kind: "item", id: "trash", label: t("mailDetail.trash"), icon: <Trash2 className="w-4 h-4" />, danger: true, onSelect: () => onBulkAction!("trash") },
  ];

  return <ContextMenu entries={bulkMode ? bulk : single} x={x} y={y} onClose={onClose} />;
}
