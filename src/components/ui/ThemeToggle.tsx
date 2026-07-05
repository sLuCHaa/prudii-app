import { Moon, Sun, Monitor } from "lucide-react";
import { useAppStore } from "../../stores/appStore";

const MODES = ["light", "dark", "system"] as const;

export function ThemeToggle() {
  const { themeMode, setThemeMode } = useAppStore();

  function cycleTheme() {
    const idx = MODES.indexOf(themeMode);
    setThemeMode(MODES[(idx + 1) % MODES.length]);
  }

  const Icon = themeMode === "dark" ? Moon : themeMode === "light" ? Sun : Monitor;

  return (
    <button
      onClick={cycleTheme}
      className="p-2 rounded-lg hover:bg-hover transition-colors"
      title={`Theme: ${themeMode}`}
    >
      <Icon className="w-4 h-4 text-text-secondary" />
    </button>
  );
}
