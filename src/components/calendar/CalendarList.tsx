import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatDistanceToNowStrict } from "date-fns";
import {
  AlertTriangle, BellOff, Check, Clock, Download, FileUp, Link2, MoreHorizontal, Palette, Pencil, Plus, RefreshCw, Rss, Star, Trash2, Upload,
} from "lucide-react";
import type { Calendar } from "../../types/calendar";
import type { MenuEntry } from "../../lib/menuModel";
import {
  useCalendars, useCreateCalendar, useDeleteCalendar, useExportIcs, useImportCalendarFiles, useImportIcs, useRefreshSubscription,
  useUpdateCalendar,
} from "../../hooks/useCalendar";
import { useAppStore } from "../../stores/appStore";
import { CALENDAR_COLORS } from "../../lib/calendar/palette";
import { REFRESH_CHOICES, refreshLabelKey, syncState } from "../../lib/calendar/subscriptions";
import { dateLocale } from "../../lib/dateUtils";
import { useDialog } from "../ui/DialogProvider";
import { ContextMenu } from "../ui/ContextMenu";
import { SubscribeDialog, type SubscribeTarget } from "./SubscribeDialog";

const ICON = "h-4 w-4";

export function CalendarList() {
  const { t } = useTranslation();
  const dialog = useDialog();
  const addToast = useAppStore((s) => s.addToast);
  const { data: calendars = [] } = useCalendars();
  const createCalendar = useCreateCalendar();
  const updateCalendar = useUpdateCalendar();
  const deleteCalendar = useDeleteCalendar();
  const importIcs = useImportIcs();
  const importFiles = useImportCalendarFiles();
  const exportIcs = useExportIcs();
  const refresh = useRefreshSubscription();
  const [menu, setMenu] = useState<{ cal: Calendar; x: number; y: number } | null>(null);
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [subscribing, setSubscribing] = useState<SubscribeTarget | null>(null);
  const localCount = calendars.filter((c) => !c.read_only).length;

  async function runImport(cal: Calendar) {
    try {
      const result = await importIcs.mutateAsync(cal.id);
      if (result) addToast("success", t("calendar.importDone", { ...result }));
    } catch {
      // The mutation already reported the error.
    }
  }

  async function runBundleImport() {
    try {
      const result = await importFiles.mutateAsync(t("calendar.import.untitled"));
      if (!result) return;
      const touched = new Set(result.calendars.map((c) => c.calendar_id)).size;
      const events = result.calendars.reduce((n, c) => n + c.imported + c.updated, 0);
      if (touched > 0) {
        addToast("success", t("calendar.import.bundleDone", { count: touched, events: t("calendar.import.events", { count: events }) }));
      }
      if (result.failed.length > 0) {
        const shown = result.failed.slice(0, 3).map((f) => f.file).join(", ");
        const rest = result.failed.length - 3;
        const files = rest > 0 ? `${shown} ${t("calendar.import.moreFiles", { count: rest })}` : shown;
        const detail = result.failed.length === 1 ? t(result.failed[0].reason) : undefined;
        addToast("error", t("calendar.import.bundleFailed", { files }), detail);
      }
    } catch {
      // The mutation already reported the error.
    }
  }

  async function runExport(cal: Calendar) {
    try {
      if (await exportIcs.mutateAsync(cal.id)) addToast("success", t("calendar.exportDone"));
    } catch {
      // The mutation already reported the error.
    }
  }

  async function confirmDelete(cal: Calendar) {
    const feed = cal.read_only;
    const ok = await dialog.danger({
      title: t(feed ? "calendar.subscription.removeTitle" : "calendar.deleteCalendarTitle"),
      message: t(feed ? "calendar.subscription.removeMessage" : "calendar.deleteCalendarMessage", { name: cal.name }),
      confirmLabel: t(feed ? "calendar.menu.unsubscribe" : "calendar.delete"),
    });
    if (ok) deleteCalendar.mutate(cal.id);
  }

  function runRefresh(cal: Calendar) {
    refresh.mutate(cal.id, { onSuccess: () => addToast("success", t("calendar.subscription.refreshed")) });
  }

  function entries(cal: Calendar): MenuEntry[] {
    const rename: MenuEntry = { kind: "item", id: "rename", label: t("calendar.menu.rename"), icon: <Pencil className={ICON} />, onSelect: () => setRenaming(cal.id) };
    const color: MenuEntry = {
      kind: "item",
      id: "color",
      label: t("calendar.menu.color"),
      icon: <Palette className={ICON} />,
      submenu: CALENDAR_COLORS.map((c) => ({
        kind: "item" as const,
        id: c,
        label: c,
        selected: c === cal.color,
        icon: <span className="h-3 w-3 rounded-full" style={{ background: c }} />,
        onSelect: () => updateCalendar.mutate({ id: cal.id, patch: { color: c } }),
      })),
    };
    const mute: MenuEntry = {
      kind: "item",
      id: "mute",
      label: t("calendar.menu.muteReminders"),
      icon: <BellOff className={ICON} />,
      selected: cal.reminders_muted,
      onSelect: () => updateCalendar.mutate({ id: cal.id, patch: { reminders_muted: !cal.reminders_muted } }),
    };
    const exportEntry: MenuEntry = { kind: "item", id: "export", label: t("calendar.menu.export"), icon: <Download className={ICON} />, onSelect: () => void runExport(cal) };

    if (cal.read_only) {
      return [
        { kind: "item", id: "refresh", label: t("calendar.menu.refreshNow"), icon: <RefreshCw className={ICON} />, onSelect: () => runRefresh(cal) },
        {
          kind: "item",
          id: "interval",
          label: t("calendar.menu.refreshEvery"),
          icon: <Clock className={ICON} />,
          submenu: REFRESH_CHOICES.map((minutes) => ({
            kind: "item" as const,
            id: String(minutes),
            label: t(refreshLabelKey(minutes)),
            selected: cal.refresh_minutes === minutes,
            onSelect: () => updateCalendar.mutate({ id: cal.id, patch: { refresh_minutes: minutes } }),
          })),
        },
        { kind: "item", id: "link", label: t("calendar.menu.changeLink"), icon: <Link2 className={ICON} />, onSelect: () => setSubscribing({ mode: "change", calendar: cal }) },
        { kind: "separator" },
        rename,
        color,
        mute,
        exportEntry,
        { kind: "separator" },
        { kind: "item", id: "delete", label: t("calendar.menu.unsubscribe"), icon: <Trash2 className={ICON} />, danger: true, onSelect: () => void confirmDelete(cal) },
      ];
    }
    return [
      rename,
      color,
      {
        kind: "item",
        id: "default",
        label: t(cal.is_default ? "calendar.menu.isDefault" : "calendar.menu.makeDefault"),
        icon: <Star className={ICON} />,
        disabled: cal.is_default,
        onSelect: () => updateCalendar.mutate({ id: cal.id, patch: { is_default: true } }),
      },
      mute,
      { kind: "separator" },
      { kind: "item", id: "import", label: t("calendar.menu.import"), icon: <Upload className={ICON} />, onSelect: () => void runImport(cal) },
      exportEntry,
      { kind: "separator" },
      {
        kind: "item",
        id: "delete",
        label: t("calendar.menu.delete"),
        icon: <Trash2 className={ICON} />,
        danger: true,
        disabled: localCount <= 1,
        onSelect: () => void confirmDelete(cal),
      },
    ];
  }

  const addEntries: MenuEntry[] = [
    { kind: "item", id: "new", label: t("calendar.newCalendar"), icon: <Plus className={ICON} />, onSelect: () => setAdding(true) },
    { kind: "item", id: "files", label: t("calendar.add.importFiles"), icon: <FileUp className={ICON} />, onSelect: () => void runBundleImport() },
    { kind: "item", id: "subscribe", label: t("calendar.add.subscribe"), icon: <Rss className={ICON} />, onSelect: () => setSubscribing({ mode: "subscribe" }) },
  ];

  return (
    <div>
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{t("calendar.calendars")}</span>
        <button
          type="button"
          aria-haspopup="menu"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setAddMenu({ x: r.left, y: r.bottom });
          }}
          aria-label={t("calendar.add.title")}
          title={t("calendar.add.title")}
          className="grid h-6 w-6 place-items-center rounded-md text-text-tertiary hover:bg-hover hover:text-text"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="space-y-0.5">
        {calendars.map((cal) => (
          <li
            key={cal.id}
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ cal, x: e.clientX, y: e.clientY });
            }}
            className="group flex items-center gap-2 rounded-md px-1 py-1 hover:bg-hover"
          >
            <button
              type="button"
              role="checkbox"
              aria-checked={cal.visible}
              aria-label={cal.name}
              onClick={() => updateCalendar.mutate({ id: cal.id, patch: { visible: !cal.visible } })}
              className="grid h-3.5 w-3.5 shrink-0 place-items-center rounded-[4px] border-2"
              style={{ borderColor: cal.color, background: cal.visible ? cal.color : "transparent" }}
            >
              {cal.visible && <Check className="h-2.5 w-2.5 text-white" strokeWidth={3} />}
            </button>
            {renaming === cal.id ? (
              <NameInput
                initial={cal.name}
                onDone={(name) => {
                  setRenaming(null);
                  if (name && name !== cal.name) updateCalendar.mutate({ id: cal.id, patch: { name } });
                }}
              />
            ) : (
              <span onDoubleClick={() => setRenaming(cal.id)} className="min-w-0 flex-1 truncate text-xs text-text">
                {cal.name}
              </span>
            )}
            {cal.reminders_muted && (
              <BellOff className="h-3 w-3 shrink-0 text-text-tertiary" aria-label={t("calendar.menu.muteReminders")} />
            )}
            {cal.read_only && <SubscriptionStatus cal={cal} />}
            <button
              type="button"
              aria-haspopup="menu"
              aria-label={cal.name}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenu({ cal, x: r.left, y: r.bottom });
              }}
              className="grid h-5 w-5 place-items-center rounded text-text-tertiary opacity-0 hover:bg-hover group-hover:opacity-100 focus:opacity-100"
            >
              <MoreHorizontal className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
        {adding && (
          <li className="px-1 py-1">
            <NameInput
              initial=""
              placeholder={t("calendar.calendarName")}
              onDone={(name) => {
                setAdding(false);
                if (name) createCalendar.mutate({ name, color: CALENDAR_COLORS[calendars.length % CALENDAR_COLORS.length] });
              }}
            />
          </li>
        )}
      </ul>
      {menu && <ContextMenu entries={entries(menu.cal)} x={menu.x} y={menu.y} onClose={() => setMenu(null)} />}
      {addMenu && <ContextMenu entries={addEntries} x={addMenu.x} y={addMenu.y} onClose={() => setAddMenu(null)} />}
      {subscribing && <SubscribeDialog target={subscribing} onClose={() => setSubscribing(null)} />}
    </div>
  );
}

function SubscriptionStatus({ cal }: { cal: Calendar }) {
  const { t } = useTranslation();
  const state = syncState(cal);
  const ago = (d: Date) => formatDistanceToNowStrict(d, { addSuffix: true, locale: dateLocale() });
  if (state.kind === "error") {
    const tip = [t(state.error), state.lastOk ? t("calendar.subscription.lastSuccess", { ago: ago(state.lastOk) }) : ""].filter(Boolean).join("\n");
    return (
      <span title={tip} aria-label={tip} className="shrink-0 text-warning">
        <AlertTriangle className="h-3.5 w-3.5" />
      </span>
    );
  }
  const tip = state.kind === "ok" ? t("calendar.subscription.updatedAgo", { ago: ago(state.at) }) : t("calendar.subscription.neverUpdated");
  return (
    <span title={tip} aria-label={tip} className="shrink-0 text-text-tertiary">
      <Link2 className="h-3.5 w-3.5" />
    </span>
  );
}

function NameInput({ initial, placeholder, onDone }: { initial: string; placeholder?: string; onDone: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  const done = useRef(false);
  const finish = (name: string) => {
    if (done.current) return;
    done.current = true;
    onDone(name.trim());
  };
  return (
    <input
      autoFocus
      value={value}
      placeholder={placeholder}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") finish(value);
        if (e.key === "Escape") {
          e.stopPropagation();
          finish("");
        }
      }}
      onBlur={() => finish(value)}
      className="h-6 min-w-0 flex-1 rounded border border-accent bg-surface px-1.5 text-xs text-text outline-none"
    />
  );
}
