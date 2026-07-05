import { WebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow, currentMonitor } from "@tauri-apps/api/window";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { emitTo, listen } from "@tauri-apps/api/event";
import { isMacOS } from "./platform";
import type { ComposeInitData } from "../components/compose/ComposeModal";

let composeCounter = 0;
let opening = false;

export async function openComposeWindow(data: ComposeInitData): Promise<void> {
  // Prevent duplicate opens (React StrictMode runs effects twice)
  if (opening) return;
  opening = true;
  setTimeout(() => { opening = false; }, 300);

  try {
    const label = `compose-${++composeCounter}`;

    // Adaptive sizing based on current monitor (logical pixels)
    let composeW = 740;
    let composeH = 680;
    let scale = 1;
    try {
      const monitor = await currentMonitor();
      if (monitor) {
        scale = monitor.scaleFactor ?? 1;
        const sw = Math.round(monitor.size.width / scale);
        const sh = Math.round(monitor.size.height / scale);
        // Leave room for menu bar + dock (~100 logical px)
        const availH = sh - 100;
        if (sw <= 1366) {
          composeW = Math.max(500, Math.round(sw * 0.55));
          composeH = Math.max(400, Math.round(availH * 0.8));
        } else {
          composeW = Math.min(740, Math.max(500, Math.round(sw * 0.45)));
          composeH = Math.min(680, Math.max(400, Math.round(availH * 0.75)));
        }
      }
    } catch {
      // Fallback to defaults
    }

    // Center the compose window on the main window's current position,
    // with a slight cascade offset so multiple windows don't stack exactly
    const cascadeOffset = ((composeCounter - 1) % 8) * 25;
    let x: number | undefined;
    let y: number | undefined;
    try {
      const main = getCurrentWindow();
      const pos = await main.outerPosition();
      const size = await main.outerSize();
      const mainX = pos.x / scale;
      const mainY = pos.y / scale;
      const mainW = size.width / scale;
      const mainH = size.height / scale;
      x = Math.round(mainX + (mainW - composeW) / 2 + cascadeOffset);
      y = Math.round(mainY + (mainH - composeH) / 2 + cascadeOffset);
    } catch {
      // Fallback: let Tauri center it
    }

    // Listen for the compose window's "ready" signal before sending data
    let readyUnlisten: (() => void) | null = null;
    const readyPromise = new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 3000);

      listen<string>("compose-ready", (event) => {
        if (event.payload === label) {
          clearTimeout(timeout);
          resolve();
        }
      }).then((fn) => {
        readyUnlisten = fn;
        // If readyPromise already resolved, clean up immediately
        readyPromise.then(() => fn());
      });
    });

    const webview = new WebviewWindow(label, {
      url: "index.html?compose=true",
      title: "Compose",
      width: composeW,
      height: composeH,
      minWidth: 500,
      minHeight: 400,
      x,
      y,
      center: x === undefined,
      // macOS: native decorations with overlay title bar (traffic lights over
      // our custom bar, real rounded corners). Windows/Linux: frameless.
      decorations: isMacOS,
      ...(isMacOS
        ? {
            titleBarStyle: "overlay" as const,
            hiddenTitle: true,
            trafficLightPosition: new LogicalPosition(12, 16),
          }
        : {}),
      // Native window background matching the theme, so the window never flashes
      // WebView2's white default before the web content paints.
      backgroundColor: data.darkMode ? [15, 23, 42, 255] : [255, 255, 255, 255],
      maximizable: false,
      visible: false,
      dragDropEnabled: false,
    });

    webview.once("tauri://destroyed", () => {
      if (readyUnlisten) { readyUnlisten(); readyUnlisten = null; }
    });

    webview.once("tauri://created", async () => {
      await readyPromise;
      try {
        await emitTo(label, "compose-init", data);
      } catch {
        // Window may have been closed already
      }
    });

    webview.once("tauri://error", () => {
      if (readyUnlisten) { readyUnlisten(); readyUnlisten = null; }
    });
  } catch (err) {
    console.error("Failed to open compose window:", err);
  }
}
