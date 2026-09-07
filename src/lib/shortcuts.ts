import type { KeyLike } from "./browserKeyGuard";

export type GlobalAction =
  | "newMessage"
  | "search"
  | "addAccount"
  | "help"
  | "settings"
  | "reply"
  | "replyAll"
  | "forward"
  | "syncAll"
  | "toggleFullscreen"
  | "openTasks"
  | "newTask";

// Ids emitted by the native macOS menu bar (src-tauri/src/lib.rs).
export const MENU_ACTIONS: Record<string, GlobalAction> = {
  "menu:new_message": "newMessage",
  "menu:settings": "settings",
  "menu:sync_all": "syncAll",
  "menu:reply": "reply",
  "menu:reply_all": "replyAll",
  "menu:forward": "forward",
};

// On macOS these arrive through the menu accelerator and the "menu" event;
// resolving them here as well would fire every action twice.
const MAC_MENU_COMBOS: ReadonlySet<GlobalAction> = new Set(Object.values(MENU_ACTIONS));

export function resolveGlobalShortcut(e: KeyLike, isMac: boolean): GlobalAction | null {
  if (e.altKey) return null;
  const mod = e.ctrlKey || e.metaKey;

  if (!mod) {
    if (e.key === "c") return "newMessage";
    if (e.key === "t") return "newTask";
    if (e.key === "/") return "search";
    if (e.key === "?") return "help";
    if (e.key === "F11") return isMac ? null : "toggleFullscreen";
    return null;
  }

  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  let action: GlobalAction | null = null;
  if (e.shiftKey) {
    if (key === "a") action = "addAccount";
    else if (key === "r") action = "replyAll";
    else if (key === "f") action = "forward";
    else if (key === "n") action = "syncAll";
    else if (key === "t") action = "openTasks";
  } else {
    if (key === "n") action = "newMessage";
    else if (key === ",") action = "settings";
    else if (key === "r") action = "reply";
    else if (key === "f") action = "search";
  }
  if (action && isMac && MAC_MENU_COMBOS.has(action)) return null;
  return action;
}

const MAC_GLYPHS: Record<string, string> = { Ctrl: "⌃", Alt: "⌥", Shift: "⇧", Mod: "⌘", Enter: "↩" };
const MAC_ORDER = ["⌃", "⌥", "⇧", "⌘"];

// "Mod+Shift+A" → "Ctrl+Shift+A" on Windows/Linux, "⇧⌘A" on macOS.
export function formatShortcut(keys: string, isMac: boolean): string {
  if (!keys.includes("+")) return keys;
  const parts = keys.split("+");
  if (!isMac) return parts.map((p) => (p === "Mod" ? "Ctrl" : p)).join("+");
  const glyphs = parts.map((p) => MAC_GLYPHS[p] ?? p);
  const mods = glyphs.filter((g) => MAC_ORDER.includes(g)).sort((a, b) => MAC_ORDER.indexOf(a) - MAC_ORDER.indexOf(b));
  const rest = glyphs.filter((g) => !MAC_ORDER.includes(g));
  return [...mods, ...rest].join("");
}
