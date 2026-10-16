import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Check, Download, MoreHorizontal, Palette, Pencil, Plus, Star, Trash2, Upload } from "lucide-react";
import type { Calendar } from "../../types/calendar";
import type { MenuEntry } from "../../lib/menuModel";
import { useCalendars, useCreateCalendar, useDeleteCalendar, useExportIcs, useImportIcs, useUpdateCalendar } from "../../hooks/useCalendar";
import { useAppStore } from "../../stores/appStore";
import { useDialog } from "../ui/DialogProvider";
import { ContextMenu } from "../ui/ContextMenu";
import { CALENDAR_COLORS } from "../../lib/calendar/palette";

export function CalendarList() {
  const { t } = useTranslation();
  const dialog = useDialog();
  const addToast = useAppStore((s) => s.addToast);
  const { data: calendars = [] } = useCalendars();
  const createCalendar = useCreateCalendar();
  const updateCalendar = useUpdateCalendar();
  const deleteCalendar = useDeleteCalendar();
  const importIcs = useImportIcs();
  const exportIcs = useExportIcs();
  const [menu, setMenu] = useState<{ cal: Calendar; x: number; y: number } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);

  async function runImport(cal: Calendar) {
    try {
      const result = await importIcs.mutateAsync(cal.id);
      if (result) addToast("success", t("calendar.importDone", { ...result }));
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
    const ok = await dialog.danger({
      title: t("calendar.deleteCalendarTitle"),
      message: t("calendar.deleteCalendarMessage", { name: cal.name }),
      confirmLabel: t("calendar.delete"),
    });
    if (ok) deleteCalendar.mutate(cal.id);
  }

  function entries(cal: Calendar): MenuEntry[] {
    return [
      { kind: "item", id: "rename", label: t("calendar.menu.rename"), icon: <Pencil className="h-4 w-4" />, onSelect: () => setRenaming(cal.id) },
      {
        kind: "item",
        id: "color",
        label: t("calendar.menu.color"),
        icon: <Palette className="h-4 w-4" />,
        submenu: CALENDAR_COLORS.map((color) => ({
          kind: "item" as const,
          id: color,
          label: color,
          selected: color === cal.color,
          icon: <span className="h-3 w-3 rounded-full" style={{ background: color }} />,
          onSelect: () => updateCalendar.mutate({ id: cal.id, patch: { color } }),
        })),
      },
      {
        kind: "item",
        id: "default",
        label: t(cal.is_default ? "calendar.menu.isDefault" : "calendar.menu.makeDefault"),
        icon: <Star className="h-4 w-4" />,
        disabled: cal.is_default,
        onSelect: () => updateCalendar.mutate({ id: cal.id, patch: { is_default: true } }),
      },
      { kind: "separator" },
      { kind: "item", id: "import", label: t("calendar.menu.import"), icon: <Upload className="h-4 w-4" />, onSelect: () => void runImport(cal) },
      { kind: "item", id: "export", label: t("calendar.menu.export"), icon: <Download className="h-4 w-4" />, onSelect: () => void runExport(cal) },
      { kind: "separator" },
      {
        kind: "item",
        id: "delete",
        label: t("calendar.menu.delete"),
        icon: <Trash2 className="h-4 w-4" />,
        danger: true,
        disabled: calendars.length <= 1,
        onSelect: () => void confirmDelete(cal),
      },
    ];
  }

  return (
    <div>
      <div className="flex items-center justify-between px-1 pb-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-text-tertiary">{t("calendar.calendars")}</span>
        <button
          type="button"
          onClick={() => setAdding(true)}
          aria-label={t("calendar.newCalendar")}
          title={t("calendar.newCalendar")}
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
    </div>
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
