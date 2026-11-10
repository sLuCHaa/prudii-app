import { useState } from "react";
import { useTranslation } from "react-i18next";
import { CalendarDays, ClipboardList, Paperclip, Shield } from "../icons";
import { useAppStore } from "../../stores/appStore";
import { useTodayCount } from "../../hooks/useCalendar";
import { useOpenTaskCount } from "../../hooks/useTasks";
import { isMailDrag, readMailDrag } from "../../lib/mailDrag";
import { CreateTaskFromMail } from "../tasks/CreateTaskFromMail";

/** The views that are not mailboxes: a bar under the list, or icons in the collapsed rail. */
export function SidebarTools({ rail = false }: { rail?: boolean }) {
  const { t } = useTranslation();
  const showTasks = useAppStore((s) => s.showTasks);
  const setShowTasks = useAppStore((s) => s.setShowTasks);
  const showCalendar = useAppStore((s) => s.showCalendar);
  const setShowCalendar = useAppStore((s) => s.setShowCalendar);
  const showAttachmentBrowser = useAppStore((s) => s.showAttachmentBrowser);
  const setShowAttachmentBrowser = useAppStore((s) => s.setShowAttachmentBrowser);
  const showMailboxCheck = useAppStore((s) => s.showMailboxCheck);
  const setShowMailboxCheck = useAppStore((s) => s.setShowMailboxCheck);
  const { data: todayCount = 0 } = useTodayCount();
  const { data: openTaskCount = 0 } = useOpenTaskCount();
  const [taskFromMailId, setTaskFromMailId] = useState<string | null>(null);
  const [tasksDropActive, setTasksDropActive] = useState(false);

  function handleTasksDragOver(e: React.DragEvent) {
    if (!isMailDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    if (!tasksDropActive) setTasksDropActive(true);
  }

  // Only clear once the pointer actually leaves the entry — dragleave also
  // fires when moving over a child element (icon/badge), same as folders.
  function handleTasksDragLeave(e: React.DragEvent) {
    if (e.currentTarget.contains(e.relatedTarget as Node)) return;
    setTasksDropActive(false);
  }

  function handleTasksDrop(e: React.DragEvent) {
    if (!isMailDrag(e.dataTransfer)) return;
    e.preventDefault();
    setTasksDropActive(false);
    const dragged = readMailDrag(e.dataTransfer);
    if (dragged) setTaskFromMailId(dragged.mailId);
  }

  const tools = [
    { id: "tasks", label: t("sidebar.tasks"), short: t("sidebar.tools.tasks"), icon: <ClipboardList className="w-4 h-4" />, onClick: () => setShowTasks(!showTasks), isActive: showTasks, count: openTaskCount },
    { id: "calendar", label: t("sidebar.calendar"), short: t("sidebar.tools.calendar"), icon: <CalendarDays className="w-4 h-4" />, onClick: () => setShowCalendar(!showCalendar), isActive: showCalendar, count: todayCount },
    { id: "attachments", label: t("sidebar.attachments"), short: t("sidebar.tools.attachments"), icon: <Paperclip className="w-4 h-4" />, onClick: () => setShowAttachmentBrowser(!showAttachmentBrowser), isActive: showAttachmentBrowser, count: 0 },
    { id: "check", label: t("sidebar.mailboxCheck"), short: t("sidebar.tools.check"), icon: <Shield className="w-4 h-4" />, onClick: () => setShowMailboxCheck(!showMailboxCheck), isActive: showMailboxCheck, count: 0 },
  ];

  const buttons = tools.map((tool) => {
    const takesMail = tool.id === "tasks";
    const dropActive = takesMail && tasksDropActive;
    const state = dropActive
      ? "bg-accent/10 ring-1 ring-accent/40"
      : tool.isActive
      ? "folder-active"
      : rail ? "text-text-secondary hover:bg-hover" : "text-text-secondary hover:bg-hover hover:text-text";
    return (
      <button
        key={tool.id}
        onClick={tool.onClick}
        onDragOver={takesMail ? handleTasksDragOver : undefined}
        onDragLeave={takesMail ? handleTasksDragLeave : undefined}
        onDrop={takesMail ? handleTasksDrop : undefined}
        title={dropActive ? t("tasks.dropToCreate") : tool.label}
        aria-label={tool.label}
        className={rail
          ? `relative flex items-center justify-center w-full py-1 rounded-md transition-colors ${state}`
          : `flex flex-col items-center gap-0.5 min-w-0 px-0.5 pt-1.5 pb-1 rounded-md transition-colors ${state}`}
      >
        {rail ? (
          <>
            {tool.icon}
            {tool.count > 0 && <span className="absolute top-0.5 right-1.5 w-1.5 h-1.5 rounded-full bg-accent" />}
          </>
        ) : (
          <>
            <span className="relative">
              {tool.icon}
              {tool.count > 0 && (
                <span className="absolute -top-1.5 left-2.5 min-w-[15px] h-[15px] px-1 rounded-full bg-accent text-white text-[10px] font-semibold leading-[15px] text-center tabular-nums">
                  {tool.count > 99 ? "99+" : tool.count}
                </span>
              )}
            </span>
            <span className="max-w-full truncate text-[10.5px] leading-tight">{tool.short}</span>
          </>
        )}
      </button>
    );
  });

  const taskDialog = taskFromMailId && (
    <CreateTaskFromMail mailId={taskFromMailId} onDone={() => setTaskFromMailId(null)} />
  );

  if (rail) return <>{buttons}{taskDialog}</>;

  return (
    <>
      <div className="grid grid-cols-4 gap-0.5 px-2 py-1.5 border-t border-border">{buttons}</div>
      {taskDialog}
    </>
  );
}
