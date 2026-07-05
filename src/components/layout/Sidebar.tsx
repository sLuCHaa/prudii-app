import { useEffect, useState, useRef, useMemo } from "react";
import { createPortal } from "react-dom";
import {
  Inbox,
  Send,
  FileText,
  AlertOctagon,
  Archive,
  Folder,
  Plus,
  ChevronDown,
  ChevronRight,
  FolderPlus,
  Pencil,
  Trash2,
  HardDrive,
  Cloud,
  X,
  Check,
  Star,
  Flag,
  Crown,
  Clock,
  CalendarClock,
  Paperclip,
  PanelLeftClose,
  PanelLeftOpen,
  Loader2,
  AlertCircle,
} from "lucide-react";
import gsap from "gsap";
import { useAppStore, type MailFilter } from "../../stores/appStore";
import { useAccounts, useFolders } from "../../hooks/useAccounts";
import { useSyncAccount, useSyncAll } from "../../hooks/useSync";
import { ComposeButton } from "../compose/ComposeButton";
import { ThemeToggle } from "../ui/ThemeToggle";
import { TrashIcon, StarIcon } from "../icons";
import { AnimatedSyncButton } from "../ui/AnimatedSyncButton";
import { Scroller } from "../ui/Scroller";
import { Button, IconButton } from "../ui/Button";
import { CardButton } from "../ui/TabButton";
import { useDialog } from "../ui/DialogProvider";
import { SidebarAmbient } from "./SidebarAmbient";
import { createFolder, deleteFolder, renameFolder, updateFolderColor, moveMail, emptyTrash, emptySpam, prefetchFolder, countFolderMails, countCombinedFolderMails, emptyAllTrash, emptyAllSpam, countSnoozedMails, listScheduledMails, forceResyncAccount, syncFolder } from "../../lib/tauri";
import { useQueryClient } from "@tanstack/react-query";
import type { BackfillProgress, FolderType, Account as AccountType, Folder as FolderT, MailFlag } from "../../types";
import { MAIL_FLAG_COLORS } from "../../types";
import { useTranslation } from "react-i18next";
import { toastError } from "../../lib/errorToast";
import { parseSyncSubProgress } from "../../lib/syncProgress";

// Throttles on-demand syncs of Gmail's "All Mail" archive folder (excluded from
// routine sync) so opening it repeatedly doesn't re-trigger a full folder sync.
const lastArchiveSync = new Map<string, number>();
const ARCHIVE_SYNC_THROTTLE_MS = 5 * 60 * 1000;

function SyncProgressIndicator({ progress }: { progress: { message: string; folder_name: string | null; folder_index: number; folder_count: number; new_mails: number; status: string } }) {
  const progressRef = useRef<HTMLDivElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const prevMessageRef = useRef("");

  // Parse "X of Y messages" from backend message for sub-folder progress
  const { current: subCurrent, total: subTotal } = parseSyncSubProgress(progress.message);

  // Combined progress: folder-level + message-level within current folder
  const percent = useMemo(() => {
    if (progress.folder_count <= 0) return 0;
    const subFraction = subTotal > 0 ? subCurrent / subTotal : 0;
    return ((progress.folder_index + subFraction) / progress.folder_count) * 100;
  }, [progress.folder_index, progress.folder_count, subCurrent, subTotal]);

  // Friendly status line (shorter than raw backend message)
  const statusLine = useMemo(() => {
    if (progress.status === "connecting") return progress.message;
    if (progress.status === "syncing_folders") return progress.message;
    if (progress.status === "done") return progress.message;
    if (progress.status === "error") return progress.message;
    if (!progress.folder_name) return progress.message;

    // "Syncing Inbox (2/11) — 150 of 500"
    const parts = [`${progress.folder_name} (${progress.folder_index + 1}/${progress.folder_count})`];
    if (subTotal > 0) {
      parts.push(`${subCurrent.toLocaleString()} / ${subTotal.toLocaleString()}`);
    }
    return parts.join(" — ");
  }, [progress.status, progress.folder_name, progress.folder_index, progress.folder_count, subCurrent, subTotal]);

  useEffect(() => {
    if (!progressRef.current || !glowRef.current) return;
    gsap.to(progressRef.current, { width: `${percent}%`, duration: 0.4, ease: "power2.out" });
    gsap.to(glowRef.current, { left: `${percent}%`, duration: 0.4, ease: "power2.out" });
  }, [percent]);

  useEffect(() => {
    if (!glowRef.current) return;
    gsap.to(glowRef.current, { opacity: 0.3, scale: 1.5, duration: 0.8, ease: "power1.inOut", yoyo: true, repeat: -1 });
    return () => { gsap.killTweensOf(glowRef.current); };
  }, []);

  // Detect activity: message changes = something is happening
  const isActive = progress.message !== prevMessageRef.current;
  useEffect(() => { prevMessageRef.current = progress.message; }, [progress.message]);

  return (
    <div className="px-2 ml-5 mb-2">
      <div className="flex items-center gap-1.5 mb-1.5">
        <div className={`w-2.5 h-2.5 rounded-full shrink-0 ${isActive ? "bg-accent animate-pulse" : "bg-text-tertiary"}`} />
        <p className="text-xs text-accent font-medium truncate flex-1">
          {statusLine}
        </p>
        {progress.new_mails > 0 && (
          <span className="text-xs text-text-tertiary shrink-0">+{progress.new_mails.toLocaleString()}</span>
        )}
      </div>
      {progress.folder_count > 0 && progress.status === "syncing_mails" && (
        <div className="relative h-1.5 rounded-full bg-border overflow-hidden">
          <div
            ref={progressRef}
            className="absolute h-full bg-linear-to-r from-accent to-purple-500 rounded-full transition-none"
            style={{ width: "0%" }}
          />
          <div
            ref={glowRef}
            className="absolute top-1/2 -translate-y-1/2 w-4 h-4 bg-accent rounded-full blur-sm opacity-60"
            style={{ left: "0%", transform: "translate(-50%, -50%)" }}
          />
        </div>
      )}
    </div>
  );
}

function BackfillProgressIndicator({ progress }: { progress: BackfillProgress }) {
  const { t } = useTranslation();
  const percent = progress.total > 0 ? (progress.processed / progress.total) * 100 : 0;

  return (
    <div className="px-2 ml-5 mb-2">
      <p className="text-xs text-text-secondary truncate mb-1.5">
        {t("sidebar.downloadingEmails", { processed: progress.processed, total: progress.total })}
      </p>
      <div className="relative h-1.5 rounded-full bg-border overflow-hidden">
        <div
          className="absolute h-full bg-linear-to-r from-accent to-purple-500 rounded-full"
          style={{ width: `${percent}%`, transition: "width 0.5s ease-out" }}
        />
      </div>
    </div>
  );
}

const FOLDER_ICONS: Record<FolderType, React.ReactNode> = {
  inbox: <Inbox className="w-4 h-4" />,
  sent: <Send className="w-4 h-4" />,
  drafts: <FileText className="w-4 h-4" />,
  trash: <TrashIcon size={16} strokeWidth={1.5} />,
  spam: <AlertOctagon className="w-4 h-4" />,
  archive: <Archive className="w-4 h-4" />,
  custom: <Folder className="w-4 h-4" />,
};

const FOLDER_COLORS = [
  { id: "", nameKey: "folderColors.none", bg: "transparent" },
  { id: "red", nameKey: "folderColors.red", bg: "#ef4444" },
  { id: "orange", nameKey: "folderColors.orange", bg: "#f97316" },
  { id: "yellow", nameKey: "folderColors.yellow", bg: "#eab308" },
  { id: "green", nameKey: "folderColors.green", bg: "#22c55e" },
  { id: "blue", nameKey: "folderColors.blue", bg: "#3b82f6" },
  { id: "purple", nameKey: "folderColors.purple", bg: "#8b5cf6" },
  { id: "pink", nameKey: "folderColors.pink", bg: "#ec4899" },
  { id: "gray", nameKey: "folderColors.gray", bg: "#6b7280" },
];

function FolderContextMenu({
  folder,
  position,
  onClose,
  onRename,
  onDelete,
  onColorChange,
  onEmpty,
}: {
  folder: FolderT;
  position: { x: number; y: number };
  onClose: () => void;
  onRename: () => void;
  onDelete: () => void;
  onColorChange: (color: string) => void;
  onEmpty: () => void;
}) {
  const { t } = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPos, setAdjustedPos] = useState(position);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [onClose]);

  // Adjust position after render so menu stays within viewport
  useEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    let { x, y } = position;
    if (y + rect.height > window.innerHeight) {
      y = Math.max(4, position.y - rect.height);
    }
    if (x + rect.width > window.innerWidth) {
      x = Math.max(4, position.x - rect.width);
    }
    if (x !== position.x || y !== position.y) {
      setAdjustedPos({ x, y });
    }
  }, [position]);

  const canModify = folder.folder_type === "custom";
  const canEmpty = folder.folder_type === "trash" || folder.folder_type === "spam";

  return createPortal(
    <div
      ref={menuRef}
      className="fixed bg-surface border border-border rounded-lg shadow-lg py-1 z-9999 min-w-[180px]"
      style={{ left: adjustedPos.x, top: adjustedPos.y }}
    >
      <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border flex items-center gap-2">
        {folder.is_local ? (
          <>
            <HardDrive className="w-3 h-3" />
            {t("folder.localFolder")}
          </>
        ) : (
          <>
            <Cloud className="w-3 h-3" />
            {t("folder.serverFolder")}
          </>
        )}
      </div>

      {canEmpty && (
        <button
          onClick={onEmpty}
          className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-danger hover:bg-hover transition-colors border-b border-border"
        >
          <Trash2 className="w-4 h-4" />
          {folder.folder_type === "trash" ? t("folder.emptyTrash") : t("folder.emptySpam")}
        </button>
      )}

      <div className="px-3 py-2 border-b border-border">
        <div className="text-xs text-text-tertiary mb-2">{t("folder.folderColor")}</div>
        <div className="flex flex-wrap gap-1.5">
          {FOLDER_COLORS.map((color) => (
            <button
              key={color.id}
              onClick={() => onColorChange(color.id)}
              className={`w-5 h-5 rounded-full transition-all hover:scale-110 ${
                folder.color === color.id ? "ring-2 ring-accent ring-offset-1 ring-offset-surface" : ""
              } ${color.id === "" ? "border border-border-light" : ""}`}
              style={{ backgroundColor: color.bg }}
              title={t(color.nameKey)}
            />
          ))}
        </div>
      </div>

      {canModify && (
        <>
          <button
            onClick={onRename}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-text hover:bg-hover transition-colors"
          >
            <Pencil className="w-4 h-4" />
            {t("common.rename")}
          </button>
          <button
            onClick={onDelete}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-danger hover:bg-hover transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            {t("common.delete")}
          </button>
        </>
      )}
      {!canModify && !canEmpty && (
        <div className="px-3 py-1.5 text-xs text-text-tertiary">
          {t("folder.systemFolderHint")}
        </div>
      )}
    </div>,
    document.body
  );
}

function CreateFolderDialog({
  accountId,
  onClose,
}: {
  accountId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [isLocal, setIsLocal] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  async function handleCreate() {
    if (!name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      await createFolder(accountId, name.trim(), isLocal);
      queryClient.invalidateQueries({ queryKey: ["folders", accountId] });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setCreating(false);
    }
  }

  // Portal to <body>: the sidebar root is a positioned element with `isolate`
  // (.glass-sidebar relative isolate), which creates its own stacking context.
  // Rendered in place, this "full-screen" modal would be trapped inside the
  // ~240px sidebar column (and clipped by its overflow-hidden wrapper) instead
  // of covering the viewport. Portaling escapes that stacking context — same
  // as the context menus.
  return createPortal(
    <div
      className="fixed inset-0 modal-backdrop flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-surface rounded-xl p-4 w-80 shadow-lg">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-semibold text-text">{t("folder.newFolder")}</h3>
          <IconButton
            icon={<X />}
            aria-label={t("common.close")}
            onClick={onClose}
          />
        </div>

        <input
          ref={inputRef}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          placeholder={t("folder.folderName")}
          className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm mb-3 focus:border-accent"
        />

        <div className="flex gap-2 mb-4">
          <button
            onClick={() => setIsLocal(false)}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
              !isLocal
                ? "border-accent bg-accent-soft text-accent"
                : "border-border text-text-secondary hover:bg-hover"
            }`}
          >
            <Cloud className="w-4 h-4" />
            {t("common.server")}
          </button>
          <button
            onClick={() => setIsLocal(true)}
            className={`flex-1 flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
              isLocal
                ? "border-accent bg-accent-soft text-accent"
                : "border-border text-text-secondary hover:bg-hover"
            }`}
          >
            <HardDrive className="w-4 h-4" />
            {t("common.localOnly")}
          </button>
        </div>

        {error && (
          <p className="text-xs text-danger mb-3">{error}</p>
        )}

        <div className="flex gap-2">
          <Button variant="secondary" fullWidth onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            fullWidth
            loading={creating}
            disabled={!name.trim()}
            onClick={handleCreate}
          >
            {t("common.create")}
          </Button>
        </div>
      </div>
    </div>,
    document.body
  );
}

function UnreadBadge({ count, className = "" }: { count: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prevCount = useRef(count);

  useEffect(() => {
    if (ref.current && prevCount.current !== count) {
      gsap.fromTo(ref.current,
        { scale: 1.4 },
        { scale: 1, duration: 0.3, ease: "back.out(2)" }
      );
    }
    prevCount.current = count;
  }, [count]);

  return (
    <span ref={ref} className={`text-xs font-bold text-accent tabular-nums ${className}`}>
      {count}
    </span>
  );
}

function AccountSection({ account, collapsed }: { account: AccountType; collapsed: boolean }) {
  const { t } = useTranslation();
  const accountExpandedStates = useAppStore((s) => s.accountExpandedStates);
  const toggleAccountExpanded = useAppStore((s) => s.toggleAccountExpanded);
  const expanded = accountExpandedStates[account.id] ?? true;
  const [contextMenu, setContextMenu] = useState<{ folder: FolderT; x: number; y: number } | null>(null);
  const [renamingFolder, setRenamingFolder] = useState<FolderT | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const folderRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const dotRef = useRef<HTMLSpanElement>(null);
  const selectedFolderId = useAppStore((s) => s.selectedFolderId);
  const setSelectedFolderId = useAppStore((s) => s.setSelectedFolderId);
  const setSelectedAccountId = useAppStore((s) => s.setSelectedAccountId);
  const setActiveFilter = useAppStore((s) => s.setActiveFilter);
  const appSettings = useAppStore((s) => s.appSettings);
  const syncProgress = useAppStore((s) => s.syncProgress[account.id]);
  const backfillProgress = useAppStore((s) => s.backfillProgress[account.id]);
  const { data: folders } = useFolders(account.id);
  const syncMutation = useSyncAccount();
  const queryClient = useQueryClient();
  const dialog = useDialog();

  const setFolderRef = (id: string, el: HTMLButtonElement | null) => {
    if (el) {
      folderRefs.current.set(id, el);
    } else {
      folderRefs.current.delete(id);
    }
  };

  function handleDragOver(e: React.DragEvent, folder: FolderT) {
    e.preventDefault();
    e.stopPropagation();
    // Only allow drop on folders that belong to the same account
    const mailAccountId = e.dataTransfer.types.includes("application/x-mail-account-id")
      ? "check" : null;
    if (mailAccountId && dragOverFolderId !== folder.id) {
      e.dataTransfer.dropEffect = "move";
      setDragOverFolderId(folder.id);

      const folderEl = folderRefs.current.get(folder.id);
      if (folderEl) {
        gsap.to(folderEl, {
          scale: 1.02,
          x: 4,
          duration: 0.2,
          ease: "power2.out",
        });
      }
    }
  }

  function handleDragLeave(e: React.DragEvent, folder: FolderT) {
    e.preventDefault();
    e.stopPropagation();

    // Check if we're actually leaving the button (not just moving to a child element)
    const folderEl = folderRefs.current.get(folder.id);
    const relatedTarget = e.relatedTarget as Node | null;

    if (folderEl && relatedTarget && folderEl.contains(relatedTarget)) {
      return;
    }

    if (folderEl) {
      gsap.to(folderEl, {
        scale: 1,
        x: 0,
        duration: 0.2,
        ease: "power2.out",
      });
    }

    setDragOverFolderId(null);
  }

  async function handleDrop(e: React.DragEvent, folder: FolderT) {
    e.preventDefault();
    e.stopPropagation();

    const folderEl = folderRefs.current.get(folder.id);
    if (folderEl) {
      gsap.to(folderEl, {
        scale: 1.05,
        duration: 0.1,
        ease: "power2.out",
        onComplete: () => {
          gsap.to(folderEl, {
            scale: 1,
            x: 0,
            duration: 0.3,
            ease: "back.out(1.7)",
          });
        },
      });
    }

    setDragOverFolderId(null);

    const mailId = e.dataTransfer.getData("application/x-mail-id");
    const mailAccountId = e.dataTransfer.getData("application/x-mail-account-id");

    if (!mailId) return;

    if (mailAccountId !== account.id) {
      await dialog.alert({
        type: "danger",
        title: t("folder.cannotMove"),
        message: t("folder.cannotMoveDesc"),
      });
      return;
    }

    // Optimistic: remove mail from local list immediately
    const { mails, setMails, selectedMailId, setSelectedMailId, selectedMailIndex } = useAppStore.getState();
    const remaining = mails.filter((m) => m.id !== mailId);
    setMails(remaining);
    if (selectedMailId === mailId) {
      const nextIndex = Math.min(selectedMailIndex, remaining.length - 1);
      setSelectedMailId(remaining.length > 0 ? remaining[nextIndex].id : null);
    }

    moveMail(mailId, folder.id)
      .then(() => {
        queryClient.invalidateQueries({ queryKey: ["folders", account.id] });
      })
      .catch(async (err) => {
        // Revert by refetching
        queryClient.invalidateQueries({ queryKey: ["mails"] });
        queryClient.invalidateQueries({ queryKey: ["filtered-mails"] });
        queryClient.invalidateQueries({ queryKey: ["all-inbox-mails"] });
        queryClient.invalidateQueries({ queryKey: ["combined-folder-mails"] });
        await dialog.alert({
          type: "danger",
          title: t("folder.moveFailed"),
          message: err instanceof Error ? err.message : String(err),
        });
      });
  }

  function handleSync(e: React.MouseEvent) {
    e.stopPropagation();
    if (e.shiftKey) {
      handleForceResync();
    } else {
      syncMutation.mutate(account.id);
    }
  }

  async function handleForceResync() {
    const confirmed = await dialog.confirm({
      title: t("sidebar.forceResyncTitle"),
      message: t("sidebar.forceResyncMessage"),
      confirmLabel: t("sidebar.forceResyncConfirm"),
    });
    if (!confirmed) return;
    forceResyncAccount(account.id);
  }

  function handleFolderContextMenu(e: React.MouseEvent, folder: FolderT) {
    e.preventDefault();
    setContextMenu({ folder, x: e.clientX, y: e.clientY });
  }

  async function handleDeleteFolder() {
    if (!contextMenu) return;
    const folder = contextMenu.folder;
    setContextMenu(null);

    const confirmed = await dialog.danger({
      title: t("folder.deleteFolder"),
      message: t("folder.deleteFolderConfirm", { name: folder.name }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
    });

    if (!confirmed) return;

    try {
      await deleteFolder(folder.id);
      queryClient.invalidateQueries({ queryKey: ["folders", account.id] });
      if (selectedFolderId === folder.id) {
        setSelectedFolderId(null);
      }
    } catch (err) {
      await dialog.alert({
        type: "danger",
        title: t("folder.deleteFailed"),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleEmptyFolder() {
    if (!contextMenu) return;
    const folder = contextMenu.folder;
    setContextMenu(null);

    const isTrash = folder.folder_type === "trash";
    const folderName = isTrash ? t("folder.types.trash") : t("folder.types.spam");

    // Use actual DB count instead of folder.total_count (which can be stale for API accounts)
    let mailCount: number;
    try {
      mailCount = await countFolderMails(folder.id);
    } catch (e) {
      toastError(e, "errors.countFolderMails");
      return;
    }

    const confirmed = await dialog.danger({
      title: t("folder.emptyConfirmTitle", { name: folderName }),
      message: t("folder.emptyConfirmMessage", { count: mailCount, name: folderName }),
      confirmLabel: t("folder.emptyConfirmButton"),
      cancelLabel: t("common.cancel"),
    });

    if (!confirmed) return;

    try {
      const count = isTrash
        ? await emptyTrash(account.id)
        : await emptySpam(account.id);

      queryClient.invalidateQueries({ queryKey: ["mails"] });
      queryClient.invalidateQueries({ queryKey: ["filtered-mails"] });
      queryClient.invalidateQueries({ queryKey: ["all-inbox-mails"] });
      queryClient.invalidateQueries({ queryKey: ["folders", account.id] });

      if (selectedFolderId === folder.id) {
        queryClient.refetchQueries({ queryKey: ["mails", folder.id] });
      }

      await dialog.alert({
        type: "success",
        title: t("folder.emptiedTitle", { name: folderName }),
        message: t("folder.emptiedMessage", { count }),
      });
    } catch (err) {
      await dialog.alert({
        type: "danger",
        title: t("common.error"),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  function handleStartRename() {
    if (!contextMenu) return;
    setRenamingFolder(contextMenu.folder);
    setRenameValue(contextMenu.folder.name);
    setContextMenu(null);
  }

  async function handleColorChange(color: string) {
    if (!contextMenu) return;
    const folder = contextMenu.folder;
    setContextMenu(null);
    try {
      await updateFolderColor(folder.id, color);
      queryClient.invalidateQueries({ queryKey: ["folders", account.id] });
    } catch (err) {
      await dialog.alert({
        type: "danger",
        title: t("folder.colorUpdateFailed"),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function handleRename() {
    if (!renamingFolder || !renameValue.trim()) return;
    try {
      await renameFolder(renamingFolder.id, renameValue.trim());
      queryClient.invalidateQueries({ queryKey: ["folders", account.id] });
    } catch (err) {
      await dialog.alert({
        type: "danger",
        title: t("folder.renameFailed"),
        message: err instanceof Error ? err.message : String(err),
      });
    }
    setRenamingFolder(null);
    setRenameValue("");
  }

  function handleFolderOpen(folder: FolderT) {
    useAppStore.setState({ showAllInboxes: false, activeCombinedFolder: null });
    setSelectedFolderId(folder.id);
    setSelectedAccountId(account.id);
    setActiveFilter(null);
    prefetchFolder(folder.id).catch((e) => console.error("[prefetchFolder]", folder.id, e));

    // Gmail's All Mail archive is excluded from routine sync (it duplicates the
    // whole mailbox), so sync it on demand when opened — throttled per folder.
    if (folder.folder_type === "archive" && account.auth_type !== "oauth" && account.provider === "google") {
      const now = Date.now();
      const last = lastArchiveSync.get(folder.id) ?? 0;
      if (now - last > ARCHIVE_SYNC_THROTTLE_MS) {
        lastArchiveSync.set(folder.id, now);
        syncFolder(account.id, folder.id)
          .then(() => queryClient.invalidateQueries({ queryKey: ["mails", folder.id] }))
          .catch((e) => console.warn("[syncFolder] archive sync failed", folder.id, e));
      }
    }
  }

  const isSyncing = syncMutation.isPending || (syncProgress && syncProgress.status !== "done");

  useEffect(() => {
    if (!dotRef.current) return;
    if (isSyncing) {
      gsap.to(dotRef.current, {
        scale: 1.4, opacity: 0.6, duration: 0.6,
        ease: "power1.inOut", yoyo: true, repeat: -1,
      });
    } else {
      gsap.killTweensOf(dotRef.current);
      gsap.to(dotRef.current, { scale: 1, opacity: 1, duration: 0.3 });
    }
    return () => { if (dotRef.current) gsap.killTweensOf(dotRef.current); };
  }, [isSyncing]);

  if (collapsed) {
    return (
      <div className="mb-1">
        <button
          onClick={() => {
            toggleAccountExpanded(account.id);
            setSelectedAccountId(account.id);
          }}
          className="flex items-center justify-center w-full py-1.5 rounded-md hover:bg-hover transition-colors"
          title={account.display_name}
        >
          <span
            ref={dotRef}
            className="w-3 h-3 rounded-full shrink-0"
            style={{ backgroundColor: account.color }}
          />
        </button>

        {expanded && folders && (
          <div className="mt-0.5 space-y-0.5">
            {folders.map((folder) => (
              <button
                key={folder.id}
                ref={(el) => setFolderRef(folder.id, el)}
                onClick={() => handleFolderOpen(folder)}
                onContextMenu={(e) => handleFolderContextMenu(e, folder)}
                onDragOver={(e) => handleDragOver(e, folder)}
                onDragLeave={(e) => handleDragLeave(e, folder)}
                onDrop={(e) => handleDrop(e, folder)}
                className={`relative flex items-center justify-center w-full py-1 rounded-md transition-colors ${
                  selectedFolderId === folder.id
                    ? "folder-active"
                    : dragOverFolderId === folder.id
                    ? "bg-accent/20 ring-2 ring-accent ring-inset text-accent"
                    : "text-text-secondary hover:bg-hover"
                }`}
                title={t(`folder.types.${folder.folder_type}`, { defaultValue: folder.name })}
              >
                <span className="shrink-0">
                  {FOLDER_ICONS[folder.folder_type as FolderType] || FOLDER_ICONS.custom}
                </span>
                {folder.unread_count > 0 && (appSettings.show_all_unread_counts || folder.folder_type === "inbox") && (
                  <span className="absolute top-0.5 right-1.5 w-1.5 h-1.5 rounded-full bg-accent" />
                )}
              </button>
            ))}
          </div>
        )}

        {contextMenu && (
          <FolderContextMenu
            folder={contextMenu.folder}
            position={{ x: contextMenu.x, y: contextMenu.y }}
            onClose={() => setContextMenu(null)}
            onRename={handleStartRename}
            onDelete={handleDeleteFolder}
            onColorChange={handleColorChange}
            onEmpty={handleEmptyFolder}
          />
        )}
      </div>
    );
  }

  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 group px-2 py-1">
        <span
          ref={dotRef}
          className="w-2 h-2 rounded-full shrink-0"
          style={{ backgroundColor: account.color }}
        />
        <span className="flex-1 truncate text-xs font-medium text-text-secondary">
          {account.display_name}
        </span>
        {syncProgress?.status === "error" ? (
          <span title={t("sidebar.sync.error")} aria-label={t("sidebar.sync.error")} className="shrink-0">
            <AlertCircle className="w-3 h-3 text-danger" />
          </span>
        ) : isSyncing ? (
          <span title={t("sidebar.sync.syncing")} aria-label={t("sidebar.sync.syncing")} className="shrink-0">
            <Loader2 className="w-3 h-3 text-accent animate-spin" />
          </span>
        ) : null}
        <button
          onClick={() => setShowCreateDialog(true)}
          className="p-1 rounded-md hover:bg-hover transition-colors opacity-0 group-hover:opacity-100 shrink-0 text-text-tertiary"
          title={t("sidebar.newFolder")}
        >
          <FolderPlus className="w-3 h-3" />
        </button>
        <AnimatedSyncButton
          isSyncing={isSyncing}
          onClick={handleSync}
          size={12}
        />
      </div>

      {syncProgress && (
        <SyncProgressIndicator progress={syncProgress} />
      )}
      {backfillProgress && !syncProgress && (
        <BackfillProgressIndicator progress={backfillProgress} />
      )}

      {folders && (
        <div className="mt-0.5 space-y-0.5">
          {folders.map((folder) => (
            renamingFolder?.id === folder.id ? (
              <div key={folder.id} className="flex items-center gap-1 px-1">
                <input
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleRename();
                    if (e.key === "Escape") { setRenamingFolder(null); setRenameValue(""); }
                  }}
                  autoFocus
                  className="flex-1 px-2 py-0.5 rounded border border-accent bg-bg-secondary text-text text-sm"
                />
                <button onClick={handleRename} className="p-1 text-success hover:bg-hover rounded">
                  <Check className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => { setRenamingFolder(null); setRenameValue(""); }} className="p-1 text-text-tertiary hover:bg-hover rounded">
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            ) : (
              <CardButton
                key={folder.id}
                ref={(el) => setFolderRef(folder.id, el)}
                selected={selectedFolderId === folder.id}
                onClick={() => handleFolderOpen(folder)}
                onContextMenu={(e) => handleFolderContextMenu(e, folder)}
                onDragOver={(e) => handleDragOver(e, folder)}
                onDragLeave={(e) => handleDragLeave(e, folder)}
                onDrop={(e) => handleDrop(e, folder)}
                className={`rounded-md text-sm py-1 px-2 ${
                  dragOverFolderId === folder.id
                    ? "bg-accent/20 ring-2 ring-accent ring-inset text-accent folder-drop-target"
                    : ""
                }`}
                leading={
                  <span
                    className={`flex items-center justify-center w-6 h-6 rounded-full transition-colors ${
                      folder.color ? "text-white" : ""
                    }`}
                    style={folder.color ? {
                      backgroundColor: FOLDER_COLORS.find(c => c.id === folder.color)?.bg || folder.color
                    } : undefined}
                  >
                    {FOLDER_ICONS[folder.folder_type as FolderType] || FOLDER_ICONS.custom}
                  </span>
                }
                trailing={
                  <>
                    {folder.is_local && (
                      <span title={t("folder.localFolder")}>
                        <HardDrive className="w-3 h-3 text-text-tertiary" />
                      </span>
                    )}
                    {folder.unread_count > 0 && (appSettings.show_all_unread_counts || folder.folder_type === "inbox") && (
                      <UnreadBadge count={folder.unread_count} />
                    )}
                  </>
                }
              >
                {t(`folder.types.${folder.folder_type}`, { defaultValue: folder.name })}
              </CardButton>
            )
          ))}
        </div>
      )}

      {contextMenu && (
        <FolderContextMenu
          folder={contextMenu.folder}
          position={{ x: contextMenu.x, y: contextMenu.y }}
          onClose={() => setContextMenu(null)}
          onRename={handleStartRename}
          onDelete={handleDeleteFolder}
          onColorChange={handleColorChange}
          onEmpty={handleEmptyFolder}
        />
      )}

      {showCreateDialog && (
        <CreateFolderDialog
          accountId={account.id}
          onClose={() => setShowCreateDialog(false)}
        />
      )}
    </div>
  );
}

function CombinedFoldersSection({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const showAllInboxes = useAppStore((s) => s.showAllInboxes);
  const setShowAllInboxes = useAppStore((s) => s.setShowAllInboxes);
  const activeCombinedFolder = useAppStore((s) => s.activeCombinedFolder);
  const setActiveCombinedFolder = useAppStore((s) => s.setActiveCombinedFolder);
  const accounts = useAppStore((s) => s.accounts);
  const [expanded, setExpanded] = useState(true);
  const [contextMenu, setContextMenu] = useState<{ type: string; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const dialog = useDialog();
  const queryClient = useQueryClient();

  useEffect(() => {
    if (!contextMenu) return;
    function handleClick(e: MouseEvent) {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu(null);
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [contextMenu]);

  if (accounts.length < 2) return null;

  const combinedFolders: { type: string; label: string; icon: React.ReactNode }[] = [
    { type: "inbox", label: t("sidebar.allInboxes"), icon: <Inbox className="w-4 h-4" /> },
    { type: "sent", label: t("sidebar.allSent"), icon: <Send className="w-4 h-4" /> },
    { type: "drafts", label: t("sidebar.allDrafts"), icon: <FileText className="w-4 h-4" /> },
    { type: "trash", label: t("sidebar.allTrash"), icon: <TrashIcon size={16} strokeWidth={1.5} /> },
    { type: "spam", label: t("sidebar.allSpam"), icon: <AlertOctagon className="w-4 h-4" /> },
    { type: "archive", label: t("sidebar.allArchive"), icon: <Archive className="w-4 h-4" /> },
  ];

  function handleClick(folderType: string) {
    if (folderType === "inbox") {
      setShowAllInboxes(!showAllInboxes || activeCombinedFolder !== null);
    } else {
      setActiveCombinedFolder(activeCombinedFolder === folderType ? null : folderType);
    }
  }

  function isActive(folderType: string) {
    if (folderType === "inbox") return showAllInboxes;
    return activeCombinedFolder === folderType;
  }

  function handleContextMenu(e: React.MouseEvent, folderType: string) {
    if (folderType !== "trash" && folderType !== "spam") return;
    e.preventDefault();
    setContextMenu({ type: folderType, x: e.clientX, y: e.clientY });
  }

  async function handleEmpty() {
    if (!contextMenu) return;
    const isTrash = contextMenu.type === "trash";
    const folderName = isTrash ? t("folder.types.trash") : t("folder.types.spam");
    setContextMenu(null);

    let mailCount: number;
    try {
      mailCount = await countCombinedFolderMails(contextMenu.type);
    } catch (e) {
      toastError(e, "errors.countFolderMails");
      return;
    }

    const confirmed = await dialog.danger({
      title: t("folder.emptyConfirmTitle", { name: folderName }),
      message: t("folder.emptyConfirmMessage", { count: mailCount, name: folderName }),
      confirmLabel: t("folder.emptyConfirmButton"),
      cancelLabel: t("common.cancel"),
    });

    if (!confirmed) return;

    try {
      const count = isTrash ? await emptyAllTrash() : await emptyAllSpam();
      queryClient.invalidateQueries({ queryKey: ["mails"] });
      queryClient.invalidateQueries({ queryKey: ["filtered-mails"] });
      queryClient.invalidateQueries({ queryKey: ["all-inbox-mails"] });
      queryClient.invalidateQueries({ queryKey: ["combined-folder-mails"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });

      await dialog.alert({
        type: "success",
        title: t("folder.emptiedTitle", { name: folderName }),
        message: t("folder.emptiedMessage", { count }),
      });
    } catch (err) {
      await dialog.alert({
        type: "danger",
        title: t("common.error"),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (collapsed) {
    return (
      <div className="mb-2 space-y-0.5">
        {combinedFolders.map((cf) => (
          <button
            key={cf.type}
            onClick={() => handleClick(cf.type)}
            onContextMenu={(e) => handleContextMenu(e, cf.type)}
            className={`flex items-center justify-center w-full py-1 rounded-md transition-colors ${
              isActive(cf.type)
                ? "folder-active"
                : "text-text-secondary hover:bg-hover"
            }`}
            title={cf.label}
          >
            {cf.icon}
          </button>
        ))}

        {contextMenu && createPortal(
          <div
            ref={contextMenuRef}
            className="fixed z-9999 min-w-[180px] bg-surface rounded-lg shadow-lg border border-border py-1"
            style={{ left: contextMenu.x, top: contextMenu.y }}
          >
            <button
              onClick={handleEmpty}
              className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-danger hover:bg-hover transition-colors"
            >
              <Trash2 className="w-4 h-4" />
              {contextMenu.type === "trash" ? t("folder.emptyTrash") : t("folder.emptySpam")}
            </button>
          </div>,
          document.body
        )}
      </div>
    );
  }

  return (
    <div className="mb-3">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-2 pt-3 pb-1.5 rounded-md hover:bg-hover transition-colors text-sm"
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-text-tertiary shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-text-tertiary shrink-0" />
        )}
        <span className="font-semibold text-[11px] uppercase tracking-wider text-text-tertiary">{t("sidebar.combinedFolders")}</span>
      </button>

      {expanded && (
        <div className="ml-4 mt-0.5 space-y-0.5">
          {combinedFolders.map((cf) => (
            <button
              key={cf.type}
              onClick={() => handleClick(cf.type)}
              onContextMenu={(e) => handleContextMenu(e, cf.type)}
              className={`flex items-center gap-2 w-full px-2 py-1 rounded-md text-sm transition-colors ${
                isActive(cf.type)
                  ? "folder-active"
                  : "text-text-secondary hover:bg-hover"
              }`}
            >
              {cf.icon}
              <span className="truncate">{cf.label}</span>
            </button>
          ))}
        </div>
      )}

      {contextMenu && createPortal(
        <div
          ref={contextMenuRef}
          className="fixed z-9999 min-w-[180px] bg-surface rounded-lg shadow-lg border border-border py-1"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <button
            onClick={handleEmpty}
            className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-danger hover:bg-hover transition-colors"
          >
            <Trash2 className="w-4 h-4" />
            {contextMenu.type === "trash" ? t("folder.emptyTrash") : t("folder.emptySpam")}
          </button>
        </div>,
        document.body
      )}
    </div>
  );
}

function ViewsSection({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const activeFilter = useAppStore((s) => s.activeFilter);
  const setActiveFilter = useAppStore((s) => s.setActiveFilter);
  const showAllInboxes = useAppStore((s) => s.showAllInboxes);
  const setShowAllInboxes = useAppStore((s) => s.setShowAllInboxes);
  const showSnoozed = useAppStore((s) => s.showSnoozed);
  const setShowSnoozed = useAppStore((s) => s.setShowSnoozed);
  const showScheduled = useAppStore((s) => s.showScheduled);
  const setShowScheduled = useAppStore((s) => s.setShowScheduled);
  const showAttachmentBrowser = useAppStore((s) => s.showAttachmentBrowser);
  const setShowAttachmentBrowser = useAppStore((s) => s.setShowAttachmentBrowser);
  const hasFeature = useAppStore((s) => s.hasFeature);
  const accounts = useAppStore((s) => s.accounts);

  const [snoozedCount, setSnoozedCount] = useState(0);
  const [scheduledCount, setScheduledCount] = useState(0);

  useEffect(() => {
    countSnoozedMails().then(setSnoozedCount).catch((e) => console.error("[countSnoozedMails]", e));
    listScheduledMails().then((mails) => setScheduledCount(mails.length)).catch((e) => console.error("[listScheduledMails]", e));
    const interval = setInterval(() => {
      countSnoozedMails().then(setSnoozedCount).catch((e) => console.error("[countSnoozedMails]", e));
      listScheduledMails().then((mails) => setScheduledCount(mails.length)).catch((e) => console.error("[listScheduledMails]", e));
    }, 60000);
    return () => clearInterval(interval);
  }, []);

  const showAllInboxesView = accounts.length >= 2;

  const views: {
    id: string;
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    isActive: boolean;
    count?: number;
    show?: boolean;
  }[] = [
    {
      id: "all-inboxes",
      label: t("sidebar.allInboxes"),
      icon: <Inbox className="w-4 h-4" />,
      onClick: () => setShowAllInboxes(!showAllInboxes),
      isActive: showAllInboxes,
      show: showAllInboxesView,
    },
    {
      id: "starred",
      label: t("sidebar.starred"),
      icon: <StarIcon size={16} strokeWidth={1.5} color="var(--c-warning)" />,
      onClick: () => setActiveFilter(activeFilter === "starred" ? null : "starred"),
      isActive: activeFilter === "starred",
      show: true,
    },
    {
      id: "snoozed",
      label: t("snooze.snoozed"),
      icon: <Clock className="w-4 h-4" />,
      onClick: () => setShowSnoozed(!showSnoozed),
      isActive: showSnoozed,
      count: snoozedCount,
      show: hasFeature("snooze") || snoozedCount > 0,
    },
    {
      id: "scheduled",
      label: t("scheduled.scheduled"),
      icon: <CalendarClock className="w-4 h-4" />,
      onClick: () => setShowScheduled(!showScheduled),
      isActive: showScheduled,
      count: scheduledCount,
      show: hasFeature("send_later") || scheduledCount > 0,
    },
    {
      id: "attachments",
      label: t("sidebar.attachments"),
      icon: <Paperclip className="w-4 h-4" />,
      onClick: () => setShowAttachmentBrowser(!showAttachmentBrowser),
      isActive: showAttachmentBrowser,
      show: true,
    },
    ...Object.entries(MAIL_FLAG_COLORS).map(([flag, { bg, nameKey }]) => ({
      id: flag,
      label: t(nameKey),
      icon: <Flag className="w-4 h-4" style={{ color: bg, fill: bg }} />,
      onClick: () => setActiveFilter(activeFilter === flag ? null : flag as MailFlag),
      isActive: activeFilter === flag,
      show: true,
    })),
  ].filter(v => v.show !== false);

  if (collapsed) {
    return (
      <div className="mb-2 space-y-0.5">
        {views.map((view) => (
          <button
            key={view.id}
            onClick={view.onClick}
            className={`relative flex items-center justify-center w-full py-1 rounded-md transition-colors ${
              view.isActive ? "folder-active" : "text-text-secondary hover:bg-hover"
            }`}
            title={view.label}
          >
            {view.icon}
            {view.count !== undefined && view.count > 0 && (
              <span className="absolute top-0.5 right-1.5 w-1.5 h-1.5 rounded-full bg-accent" />
            )}
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="mb-3">
      <div className="px-2 pt-3 pb-1.5 flex items-center gap-2">
        <div className="h-px flex-1 bg-linear-to-r from-transparent via-border to-transparent" />
        <span className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary">
          {t("sidebar.views")}
        </span>
        <div className="h-px flex-1 bg-linear-to-r from-border via-transparent to-transparent" />
      </div>

      <div className="mt-0.5 space-y-0.5">
        {views.map((view) => (
          <button
            key={view.id}
            onClick={view.onClick}
            className={`flex items-center gap-3 w-full px-3 py-2 rounded-md text-sm transition-colors ${
              view.isActive
                ? "folder-active"
                : "text-text-secondary hover:bg-hover hover:text-text"
            }`}
          >
            <span className="shrink-0">{view.icon}</span>
            <span className="flex-1 truncate text-left">{view.label}</span>
            {view.count !== undefined && view.count > 0 && (
              <UnreadBadge count={view.count} />
            )}
          </button>
        ))}
      </div>
    </div>
  );
}

export function Sidebar() {
  const { t } = useTranslation();
  const setShowAccountWizard = useAppStore((s) => s.setShowAccountWizard);
  const accounts = useAppStore((s) => s.accounts);
  const setAccounts = useAppStore((s) => s.setAccounts);
  const setSelectedAccountId = useAppStore((s) => s.setSelectedAccountId);
  const setSelectedFolderId = useAppStore((s) => s.setSelectedFolderId);
  const setFolders = useAppStore((s) => s.setFolders);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useAppStore((s) => s.toggleSidebar);
  const isAnySyncing = useAppStore((s) =>
    Object.values(s.syncProgress).some((p) => p !== null)
  );
  const canAddAccount = useAppStore((s) => {
    const plan = s.licenseInfo?.plan || "free";
    if (plan === "premium" || plan === "team") return true;
    return s.accounts.length < 3;
  });
  const { data: fetchedAccounts } = useAccounts();
  const syncAll = useSyncAll();

  useEffect(() => {
    if (fetchedAccounts) {
      setAccounts(fetchedAccounts);
      if (fetchedAccounts.length > 0 && !useAppStore.getState().selectedAccountId) {
        setSelectedAccountId(fetchedAccounts[0].id);
      }
    }
  }, [fetchedAccounts, setAccounts, setSelectedAccountId]);

  const selectedAccountId = useAppStore((s) => s.selectedAccountId);
  const { data: folders } = useFolders(selectedAccountId);
  useEffect(() => {
    if (folders) {
      setFolders(folders);
      if (folders.length > 0 && !useAppStore.getState().selectedFolderId) {
        setSelectedFolderId(folders[0].id);
      }
    }
  }, [folders, setFolders, setSelectedFolderId]);

  if (sidebarCollapsed) {
    return (
      <div className="flex flex-col h-full w-[52px] glass-sidebar relative isolate border-r border-border no-select">
        <SidebarAmbient />
        <div className="p-2 flex flex-col items-center gap-2">
          <AnimatedSyncButton
            isSyncing={isAnySyncing}
            onClick={() => syncAll.mutate()}
            size={16}
            alwaysVisible
            disabled={accounts.length === 0}
          />
          <ComposeButton collapsed />
        </div>

        <Scroller className="flex-1 px-1.5 py-1">
          <ViewsSection collapsed />

          {accounts.length > 0 && (
            <div className="h-px bg-border my-2" />
          )}

          {accounts.map((account) => (
            <AccountSection key={account.id} account={account} collapsed />
          ))}
        </Scroller>

        <div className="p-2 border-t border-border flex flex-col items-center gap-1">
          {canAddAccount && (
            <button
              onClick={() => setShowAccountWizard(true)}
              className="p-1.5 rounded-md hover:bg-hover transition-colors text-text-secondary"
              title={t("sidebar.addAccount")}
            >
              <Plus className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={toggleSidebar}
            className="p-1.5 rounded-md hover:bg-hover transition-colors text-text-tertiary"
            title={t("sidebar.expandSidebar", { defaultValue: "Expand sidebar" })}
          >
            <PanelLeftOpen className="w-4 h-4" />
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full glass-sidebar relative isolate border-r border-border no-select">
      <SidebarAmbient />
      <div className="p-3">
        <div className="flex items-center justify-between mb-3">
          <h1 className="text-lg font-bold text-text tracking-tight">
            Prudii Mail
          </h1>
          <div className="flex items-center gap-1">
            <AnimatedSyncButton
              isSyncing={isAnySyncing}
              onClick={() => syncAll.mutate()}
              size={16}
              alwaysVisible
              disabled={accounts.length === 0}
            />
            <ThemeToggle />
          </div>
        </div>
        <ComposeButton />
      </div>

      <Scroller className="flex-1 px-2 py-1">
        <ViewsSection collapsed={false} />

        {accounts.length > 0 && (
          <>
            <div className="px-2 pt-3 pb-1.5 flex items-center gap-2">
              <div className="h-px flex-1 bg-linear-to-r from-transparent via-border to-transparent" />
              <span className="text-[10px] font-semibold uppercase tracking-widest text-text-tertiary">
                {t("sidebar.accounts")}
              </span>
              <div className="h-px flex-1 bg-linear-to-r from-border via-transparent to-transparent" />
            </div>

            {accounts.map((account) => (
              <AccountSection key={account.id} account={account} collapsed={false} />
            ))}
          </>
        )}

        {accounts.length === 0 && (
          <div className="text-center py-8 px-4">
            <p className="text-sm text-text-tertiary mb-3">
              {t("sidebar.noAccounts")}
            </p>
          </div>
        )}
      </Scroller>

      <div className="p-3 border-t border-border">
        <div className="flex items-center gap-2">
          <div className="flex-1 min-w-0">
            {canAddAccount ? (
              <Button
                variant="secondary"
                fullWidth
                icon={<Plus />}
                onClick={() => setShowAccountWizard(true)}
              >
                {t("sidebar.addAccount")}
              </Button>
            ) : (
              <div className="text-center">
                <p className="text-xs text-text-tertiary mb-2">{t("sidebar.accountLimit")}</p>
                <Button
                  variant="secondary"
                  fullWidth
                  icon={<Crown />}
                  onClick={() => useAppStore.getState().setShowSettings(true)}
                >
                  {t("sidebar.upgradePremium")}
                </Button>
              </div>
            )}
          </div>
          <button
            onClick={toggleSidebar}
            className="p-1.5 rounded-md hover:bg-hover transition-colors text-text-tertiary shrink-0"
            title={t("sidebar.collapseSidebar", { defaultValue: "Collapse sidebar" })}
          >
            <PanelLeftClose className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
