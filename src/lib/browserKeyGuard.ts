export interface KeyLike {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

interface GuardOptions {
  inEditable?: boolean;
  allowDevtools?: boolean;
}

// Keys the embedded browser treats as its own chrome (reload, print, find bar,
// caret browsing, view-source, history, zoom, devtools). Tauri disables zoom
// hotkeys natively but not WebView2's accelerator keys, so they are caught here.
export function isBrowserChromeKey(e: KeyLike, opts: GuardOptions = {}): boolean {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (key === "F5" || key === "F3" || key === "F7") return true;
  if (!opts.allowDevtools && (key === "F12" || (mod && e.shiftKey && (key === "i" || key === "j" || key === "c")))) {
    return true;
  }
  if (!mod && e.altKey && (key === "ArrowLeft" || key === "ArrowRight")) return !opts.inEditable;
  if (!mod) return false;

  if (["r", "p", "f", "g", "+", "-", "=", "0"].includes(key)) return true;
  if (opts.inEditable) return false;
  return ["u", "h", "j"].includes(key);
}

function isEditable(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || !!el.isContentEditable);
}

// Capture phase and preventDefault only: app handlers further down still see
// the key (Ctrl+R becomes "reply" instead of a page reload).
export function installBrowserKeyGuard(target: Window = window): () => void {
  const allowDevtools = import.meta.env.DEV;
  const onKeyDown = (e: KeyboardEvent) => {
    if (isBrowserChromeKey(e, { inEditable: isEditable(e.target), allowDevtools })) e.preventDefault();
  };
  const onWheel = (e: WheelEvent) => {
    if (e.ctrlKey) e.preventDefault();
  };
  target.addEventListener("keydown", onKeyDown, true);
  target.addEventListener("wheel", onWheel, { passive: false, capture: true });
  return () => {
    target.removeEventListener("keydown", onKeyDown, true);
    target.removeEventListener("wheel", onWheel, { capture: true });
  };
}
