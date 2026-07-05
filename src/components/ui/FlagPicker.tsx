import { useState, useRef, useEffect } from "react";
import { Flag, Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { MAIL_FLAG_COLORS, type MailFlag } from "../../types";

interface FlagPickerProps {
  flags: string[];
  onToggleFlag: (flag: MailFlag) => void;
  size?: "sm" | "md";
}

const FLAG_ORDER: MailFlag[] = ["red", "orange", "yellow", "green", "blue", "purple", "gray"];

export function FlagPicker({ flags, onToggleFlag, size = "md" }: FlagPickerProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [open]);

  const hasFlags = flags.length > 0;
  const iconSize = size === "sm" ? 12 : 16;
  const btnPadding = size === "sm" ? "p-1" : "p-1.5";

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
        className={`${btnPadding} rounded-lg hover:bg-hover transition-colors ${
          hasFlags ? "text-text" : "text-text-tertiary"
        }`}
        title={t("flags.setFlag")}
      >
        {hasFlags ? (
          <div className="flex items-center gap-0.5">
            {flags.slice(0, 3).map((f) => (
              <Flag
                key={f}
                style={{
                  width: iconSize,
                  height: iconSize,
                  color: MAIL_FLAG_COLORS[f as MailFlag]?.bg || "#6b7280",
                  fill: MAIL_FLAG_COLORS[f as MailFlag]?.bg || "#6b7280",
                }}
              />
            ))}
            {flags.length > 3 && (
              <span className="text-xs text-text-tertiary">+{flags.length - 3}</span>
            )}
          </div>
        ) : (
          <Flag style={{ width: iconSize, height: iconSize }} />
        )}
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-1 bg-surface border border-border rounded-lg shadow-lg py-1 z-50 min-w-[140px]"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-xs text-text-tertiary border-b border-border">
            {t("flags.title")}
          </div>
          {FLAG_ORDER.map((flag) => {
            const isSelected = flags.includes(flag);
            const color = MAIL_FLAG_COLORS[flag];
            return (
              <button
                key={flag}
                onClick={() => {
                  onToggleFlag(flag);
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-text hover:bg-hover transition-colors"
              >
                <div
                  className="w-4 h-4 rounded-full flex items-center justify-center"
                  style={{ backgroundColor: color.bg }}
                >
                  {isSelected && <Check className="w-3 h-3" style={{ color: color.text }} />}
                </div>
                <span>{t(color.nameKey)}</span>
              </button>
            );
          })}
          {flags.length > 0 && (
            <>
              <div className="border-t border-border my-1" />
              <button
                onClick={() => {
                  flags.forEach((f) => onToggleFlag(f as MailFlag));
                }}
                className="flex items-center gap-2 w-full px-3 py-1.5 text-sm text-text-tertiary hover:bg-hover transition-colors"
              >
                {t("flags.clearAll")}
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

// Compact flag display for mail list
export function FlagDots({ flags, size = 8 }: { flags: string[]; size?: number }) {
  if (flags.length === 0) return null;

  return (
    <div className="flex items-center gap-0.5">
      {flags.map((f) => (
        <Flag
          key={f}
          style={{
            width: size + 2,
            height: size + 2,
            color: MAIL_FLAG_COLORS[f as MailFlag]?.bg || "#6b7280",
            fill: MAIL_FLAG_COLORS[f as MailFlag]?.bg || "#6b7280",
          }}
        />
      ))}
    </div>
  );
}
