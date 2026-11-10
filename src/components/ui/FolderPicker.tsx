import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { FolderInput, Search } from "../icons";
import { clampToViewport } from "../../lib/menuModel";
import { matchFolders } from "../../lib/moveTargets";
import type { Folder } from "../../types";

export const FOLDER_PICKER_WIDTH = 240;

export interface FolderGroup {
  label: string;
  folders: Folder[];
}

interface FolderPickerProps {
  folders: Folder[];
  accountLabel?: string;
  /** Further folder lists below the main one, each under its own heading. */
  groups?: FolderGroup[];
  x: number;
  y: number;
  onPick: (folderId: string) => void;
  onClose: () => void;
}

export function FolderPicker({ folders, accountLabel, groups, x, y, onPick, onClose }: FolderPickerProps) {
  const { t } = useTranslation();
  const rootRef = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState("");
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState({ left: x, top: y });

  const labelOf = (f: Folder) => t(`folder.types.${f.folder_type}`, { defaultValue: f.name });
  const sections = [{ label: accountLabel, folders }, ...(groups ?? [])]
    .map((section) => ({ label: section.label, folders: matchFolders(section.folders, typed, labelOf) }))
    .filter((section) => section.folders.length > 0);
  const shown = sections.flatMap((section) => section.folders);

  useLayoutEffect(() => {
    const el = rootRef.current;
    if (el) setPos(clampToViewport(x, y, el.offsetWidth, el.offsetHeight, window.innerWidth, window.innerHeight));
  }, [x, y, shown.length]);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) onClose();
    }
    // A click into a mail iframe never reaches this document, it only blurs the window.
    window.addEventListener("blur", onClose);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      window.removeEventListener("blur", onClose);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [onClose]);

  useEffect(() => {
    rootRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [active]);

  function pick(folder: Folder | undefined) {
    if (!folder) return;
    onPick(folder.id);
    onClose();
  }

  function onKeyDown(e: React.KeyboardEvent) {
    // Global shortcuts (the mail list's own keys) must not see what is typed here.
    e.stopPropagation();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (shown.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i + step + shown.length) % shown.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  }

  return createPortal(
    <div
      ref={rootRef}
      onKeyDown={onKeyDown}
      className="fixed z-9999 bg-surface rounded-lg shadow-lg inset-shadow-edge border border-border py-1 menu-enter"
      style={{ left: pos.left, top: pos.top, width: FOLDER_PICKER_WIDTH }}
    >
      <label className="mx-1.5 mb-1 flex items-center gap-2 px-2 py-1.5 rounded-md bg-bg-secondary border border-border focus-within:border-accent transition-colors">
        <Search className="w-3.5 h-3.5 shrink-0 text-text-tertiary" />
        <input
          autoFocus
          type="text"
          value={typed}
          onChange={(e) => { setTyped(e.target.value); setActive(0); }}
          placeholder={t("folder.searchFolders")}
          aria-label={t("folder.searchFolders")}
          className="flex-1 min-w-0 bg-transparent text-sm text-text placeholder:text-text-tertiary outline-none"
        />
      </label>
      <div role="listbox" aria-label={t("rules.moveToFolder")} className="max-h-[min(50vh,320px)] overflow-y-auto">
        {sections.map((section, s) => {
          const first = sections.slice(0, s).reduce((count, earlier) => count + earlier.folders.length, 0);
          return (
            <div key={section.label ?? ""} role="group" aria-label={section.label}>
              {section.label && (
                <div className="px-3 py-1.5 text-xs font-semibold text-text-tertiary truncate">{section.label}</div>
              )}
              {section.folders.map((folder, k) => {
                const i = first + k;
                return (
                  <button
                    key={folder.id}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => pick(folder)}
                    className={`w-full flex items-center gap-3 px-3 py-1.5 text-sm text-text transition-colors outline-none ${i === active ? "bg-hover" : ""}`}
                  >
                    <span className="text-text-tertiary w-4 flex justify-center"><FolderInput className="w-4 h-4" /></span>
                    <span className="flex-1 text-left truncate">{labelOf(folder)}</span>
                  </button>
                );
              })}
            </div>
          );
        })}
        {shown.length === 0 && (
          <div className="px-3 py-2 text-sm text-text-tertiary">{t("folder.noFolderFound")}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
