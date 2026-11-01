(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../lib/i18n";
import de from "../locales/de.json";
import { useAppStore } from "../stores/appStore";
import { useMailExportEvents, confirmQuitDuringExport, closeOrHide } from "./useMailExportEvents";

const handlers = new Map<string, (event: { payload: unknown }) => void>();
const cancelMailExport = vi.fn();
const openLastExportFolder = vi.fn();
const mailExportRunning = vi.fn();
const quitApp = vi.fn();
const hideToTray = vi.fn();
const danger = vi.fn();

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (event: { payload: unknown }) => void) => {
    handlers.set(name, cb);
    return Promise.resolve(() => { handlers.delete(name); });
  },
}));
vi.mock("../lib/tauri", () => ({
  cancelMailExport: () => cancelMailExport(),
  openLastExportFolder: () => openLastExportFolder(),
  mailExportRunning: () => mailExportRunning(),
  quitApp: () => quitApp(),
  hideToTray: () => hideToTray(),
}));
vi.mock("../components/ui/DialogProvider", () => ({
  useDialog: () => ({ danger }),
}));

function fire(name: string, payload: unknown) {
  act(() => handlers.get(name)?.({ payload }));
}

function Probe() {
  useMailExportEvents();
  return null;
}

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  i18n.addResourceBundle("de", "translation", de, true, true);
  await i18n.changeLanguage("de");
  handlers.clear();
  for (const m of [cancelMailExport, openLastExportFolder, mailExportRunning, quitApp, hideToTray, danger]) m.mockReset();
  cancelMailExport.mockResolvedValue(undefined);
  quitApp.mockResolvedValue(undefined);
  hideToTray.mockResolvedValue(undefined);
  mailExportRunning.mockResolvedValue(false);
  danger.mockResolvedValue(true);
  useAppStore.setState({ mailExport: { running: false, progress: null, result: null }, toasts: [] });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
  await i18n.changeLanguage("en");
});

async function mount() {
  await act(async () => { root.render(createElement(Probe)); });
}

describe("useMailExportEvents", () => {
  it("stores progress and marks the export as running", async () => {
    await mount();
    fire("mail-export-progress", { processed: 25, total: 100, localCopy: 0, failed: 0 });
    const { mailExport } = useAppStore.getState();
    expect(mailExport.running).toBe(true);
    expect(mailExport.progress).toEqual({ processed: 25, total: 100, localCopy: 0, failed: 0 });
  });

  it("stores the result and raises a notice with an open-folder action", async () => {
    await mount();
    fire("mail-export-progress", { processed: 1, total: 100, localCopy: 0, failed: 0 });
    const summary = { path: "x", exported: 98, localCopy: 1, failed: 1, cancelled: false };
    fire("mail-export-done", summary);
    const state = useAppStore.getState();
    expect(state.mailExport.running).toBe(false);
    expect(state.mailExport.result).toEqual(summary);
    const toast = state.toasts[0];
    expect(toast.title).toBe(de.mailExport.doneTitle);
    expect(toast.message).toBe("99 Mails exportiert. 1 aus lokaler Kopie, kein Original. 1 konnte nicht exportiert werden.");
    toast.action?.onClick();
    expect(openLastExportFolder).toHaveBeenCalled();
  });

  it("uses the cancelled title and omits zero counts", async () => {
    await mount();
    fire("mail-export-done", { path: "x", exported: 5, localCopy: 0, failed: 0, cancelled: true });
    const toast = useAppStore.getState().toasts[0];
    expect(toast.title).toBe(de.mailExport.cancelledTitle);
    expect(toast.message).toBe("5 Mails exportiert.");
  });

  it("keeps the notice until dismissed and warns when mails failed or the export was cancelled", async () => {
    await mount();
    const done = (failed: number, cancelled: boolean) => {
      useAppStore.setState({ toasts: [] });
      fire("mail-export-done", { path: "x", exported: 5, localCopy: 0, failed, cancelled });
      return useAppStore.getState().toasts[0];
    };
    const clean = done(0, false);
    expect(clean.type).toBe("success");
    expect(clean.sticky).toBe(true);
    expect(clean.action?.label).toBe(de.mailExport.openFolder);
    expect(done(2, false)).toMatchObject({ type: "warning", sticky: true });
    expect(done(0, true)).toMatchObject({ type: "warning", sticky: true });
  });

  it("restores the running state after a reload", async () => {
    mailExportRunning.mockResolvedValue(true);
    await mount();
    expect(useAppStore.getState().mailExport.running).toBe(true);
  });
});

describe("closeOrHide", () => {
  const t = ((key: string) => key) as never;

  it("stays open when the quit dialog fails during an export", async () => {
    useAppStore.setState({ mailExport: { running: true, progress: null, result: null } });
    danger.mockRejectedValue(new Error("dialog gone"));
    await closeOrHide(false, { danger }, t);
    expect(quitApp).not.toHaveBeenCalled();
  });

  it("asks before quitting during an export and quits right away otherwise", async () => {
    useAppStore.setState({ mailExport: { running: true, progress: null, result: null } });
    danger.mockResolvedValue(false);
    await closeOrHide(false, { danger }, t);
    expect(quitApp).not.toHaveBeenCalled();
    useAppStore.setState({ mailExport: { running: false, progress: null, result: null } });
    await closeOrHide(false, { danger }, t);
    expect(quitApp).toHaveBeenCalledTimes(1);
  });

  it("hides to the tray and only quits when hiding fails", async () => {
    await closeOrHide(true, { danger }, t);
    expect(hideToTray).toHaveBeenCalled();
    expect(quitApp).not.toHaveBeenCalled();
    hideToTray.mockRejectedValue(new Error("no tray"));
    await closeOrHide(true, { danger }, t);
    expect(quitApp).toHaveBeenCalledTimes(1);
  });
});

describe("confirmQuitDuringExport", () => {
  const t = ((key: string) => key) as never;

  it("does nothing when the user declines", async () => {
    danger.mockResolvedValue(false);
    expect(await confirmQuitDuringExport({ danger }, t)).toBe(false);
    expect(cancelMailExport).not.toHaveBeenCalled();
  });

  it("cancels and resolves once the export reports done", async () => {
    const pending = confirmQuitDuringExport({ danger }, t);
    await vi.waitFor(() => expect(cancelMailExport).toHaveBeenCalled());
    fire("mail-export-done", { path: "x", exported: 0, localCopy: 0, failed: 0, cancelled: true });
    expect(await pending).toBe(true);
  });

  it("resolves after the 10 s timeout when no done event arrives", async () => {
    vi.useFakeTimers();
    let result: boolean | undefined;
    const pending = confirmQuitDuringExport({ danger }, t).then((r) => { result = r; });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1_500);
    await pending;
    expect(result).toBe(true);
    expect(cancelMailExport).toHaveBeenCalled();
  });
});
