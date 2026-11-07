import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { SyncProgress } from "../types";
import { useAppStore } from "../stores/appStore";
import { useSyncLineSource, type SyncLine } from "./useSyncLine";

const p = (status: SyncProgress["status"]): SyncProgress => ({
  account_id: "a",
  status,
  folder_name: null,
  folder_index: 0,
  folder_count: 0,
  folder_done: 0,
  folder_total: 0,
  new_mails: 0,
  message: "",
});

let latest: SyncLine | null = null;
function Harness() {
  latest = useSyncLineSource();
  return null;
}

let clock = 0;
let root: Root;
let host: HTMLDivElement;

function at(ms: number, fn: () => void) {
  clock = ms;
  act(fn);
}

beforeEach(() => {
  clock = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  useAppStore.setState({ syncProgress: {}, syncRevealUntil: 0 });
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(createElement(Harness)));
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  latest = null;
  vi.restoreAllMocks();
});

describe("useSyncLineSource", () => {
  it("shows an account whose sync, started from outside the sidebar, ends before the push threshold", () => {
    at(10_000, () => useAppStore.getState().revealSyncLine());
    at(10_100, () => useAppStore.getState().setSyncProgress("a", p("connecting")));
    at(10_250, () => useAppStore.getState().setSyncProgress("a", p("done")));
    expect(latest!.state.a?.shown).toBe(true);
  });

  it("keeps such a short sync hidden when nobody asked for it", () => {
    at(10_100, () => useAppStore.getState().setSyncProgress("a", p("connecting")));
    at(10_250, () => useAppStore.getState().setSyncProgress("a", p("done")));
    expect(latest!.state.a?.shown).toBe(false);
  });
});
