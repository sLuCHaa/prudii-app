import { describe, it, expect } from "vitest";
import type { SyncProgress } from "../types";
import {
  advanceLine,
  lineSegments,
  lineChip,
  linePercent,
  finishedWithNewMail,
  nextDeadline,
  linePercentShown,
  PERCENT_AFTER_MS,
  REVEAL_MS,
  LINGER_MS,
  CHIP_MS,
  type LineState,
} from "./syncLine";

const p = (status: SyncProgress["status"], extra: Partial<SyncProgress> = {}): SyncProgress => ({
  account_id: "a",
  status,
  folder_name: null,
  folder_index: 0,
  folder_count: 0,
  folder_done: 0,
  folder_total: 0,
  new_mails: 0,
  message: "",
  ...extra,
});

function run(steps: [number, Record<string, SyncProgress | null>][], revealAll = false): LineState {
  let state: LineState = {};
  for (const [t, progress] of steps) state = advanceLine(state, progress, t, revealAll);
  return state;
}

describe("advanceLine", () => {
  it("reveals an account only once its sync has run for a moment", () => {
    const early = run([[0, { a: p("connecting") }], [REVEAL_MS - 1, { a: p("syncing_folders") }]]);
    expect(lineSegments(early, ["a"], REVEAL_MS - 1)).toEqual([]);

    const later = advanceLine(early, { a: p("syncing_folders") }, REVEAL_MS);
    expect(lineSegments(later, ["a"], REVEAL_MS)).toEqual([{ accountId: "a", percent: null, state: "running" }]);
  });

  it("shows a manual sync right away", () => {
    const state = run([[0, { a: p("connecting") }]], true);
    expect(lineSegments(state, ["a"], 0)).toHaveLength(1);
  });

  it("never shows a quick push sync, but still reports its new mail", () => {
    const state = run([[0, { a: p("connecting") }], [300, { a: p("done", { new_mails: 1 }) }]]);
    expect(lineSegments(state, ["a"], 300)).toEqual([]);
    expect(lineChip(state.a, 300)).toEqual({ kind: "new", count: 1 });
  });

  it("an idle sync that only reports done still counts its new mail", () => {
    const state = run([[0, { a: p("done", { new_mails: 2 }) }]]);
    expect(lineChip(state.a, 0)).toEqual({ kind: "new", count: 2 });
    expect(lineSegments(state, ["a"], 0)).toEqual([]);
  });

  it("fills from the folder counts and never moves back within a run", () => {
    const mails = (index: number, done: number) => p("syncing_mails", { folder_index: index, folder_count: 2, folder_done: done, folder_total: 10 });
    const state = run([[0, { a: p("connecting") }], [500, { a: mails(0, 5) }], [600, { a: mails(0, 2) }]]);
    expect(linePercent(state.a)).toBe(25);
  });

  it("keeps finished accounts lit while another is still running, then lets the line go", () => {
    const steps: [number, Record<string, SyncProgress | null>][] = [
      [0, { a: p("connecting"), b: p("connecting") }],
      [500, { a: p("syncing_folders"), b: p("syncing_folders") }],
      [900, { a: p("done", { new_mails: 2 }), b: p("syncing_folders") }],
    ];
    let state = run(steps);
    expect(lineSegments(state, ["a", "b"], 900)).toEqual([
      { accountId: "a", percent: 100, state: "fin" },
      { accountId: "b", percent: null, state: "running" },
    ]);
    state = advanceLine(state, { a: p("done", { new_mails: 2 }), b: p("syncing_folders") }, 900 + LINGER_MS + 100);
    expect(lineSegments(state, ["a", "b"], 900 + LINGER_MS + 100).map((s) => s.state)).toEqual(["fin", "running"]);

    state = advanceLine(state, { a: p("done", { new_mails: 2 }), b: p("done") }, 2000);
    expect(lineSegments(state, ["a", "b"], 2000).map((s) => s.state)).toEqual(["fin", "fin"]);
    expect(lineSegments(state, ["a", "b"], 2000 + LINGER_MS)).toEqual([]);
  });

  it("marks a failed account red and keeps it while others run", () => {
    let state = run([
      [0, { a: p("connecting"), b: p("connecting") }],
      [500, { a: p("syncing_folders"), b: p("error", { message: "timeout" }) }],
    ]);
    expect(lineSegments(state, ["a", "b"], 500)).toEqual([
      { accountId: "a", percent: null, state: "running" },
      { accountId: "b", percent: null, state: "error" },
    ]);
    state = advanceLine(state, { a: p("done"), b: p("error") }, 3000);
    expect(lineSegments(state, ["a", "b"], 3000 + LINGER_MS)).toEqual([]);
  });

  it("does not bring back an old failure when another account syncs later", () => {
    let state = run([[0, { a: p("connecting"), b: p("connecting") }], [500, { a: p("done"), b: p("error") }]]);
    // Much later only "a" syncs; "b" still carries its old error in the store.
    state = advanceLine(state, { a: p("connecting"), b: p("error") }, 60_000);
    state = advanceLine(state, { a: p("syncing_folders"), b: p("error") }, 60_500);
    expect(lineSegments(state, ["a", "b"], 60_500)).toEqual([{ accountId: "a", percent: null, state: "running" }]);
  });

  it("shows a check for a visible sync without new mail, and nothing for a hidden one", () => {
    const visible = run([[0, { a: p("connecting") }], [800, { a: p("syncing_folders") }], [900, { a: p("done") }]]);
    expect(lineChip(visible.a, 900)).toEqual({ kind: "ok" });
    expect(lineChip(visible.a, 900 + CHIP_MS)).toBeNull();

    const hidden = run([[0, { a: p("connecting") }], [200, { a: p("done") }]]);
    expect(lineChip(hidden.a, 200)).toBeNull();
  });

  it("forgets a finished account once its chip has played and the store cleared it", () => {
    let state = run([[0, { a: p("done", { new_mails: 1 }) }]]);
    state = advanceLine(state, { a: null }, CHIP_MS + 1);
    expect(state.a).toBeUndefined();
  });

  it("starts a fresh run when the account syncs again", () => {
    let state = run([[0, { a: p("connecting") }], [800, { a: p("done", { new_mails: 3 }) }]]);
    state = advanceLine(state, { a: p("connecting") }, 5000);
    expect(state.a.outcome).toBe("running");
    expect(state.a.since).toBe(5000);
    expect(lineSegments(state, ["a"], 5000)).toEqual([]);
  });
});

describe("finishedWithNewMail", () => {
  it("fires once when a run ends with new mail", () => {
    const before = run([[0, { a: p("connecting") }]]);
    const after = advanceLine(before, { a: p("done", { new_mails: 1 }) }, 900);
    expect(finishedWithNewMail(before, after)).toBe(true);
    expect(finishedWithNewMail(after, advanceLine(after, { a: p("done", { new_mails: 1 }) }, 950))).toBe(false);
  });

  it("stays quiet when nothing new arrived", () => {
    const before = run([[0, { a: p("connecting") }]]);
    expect(finishedWithNewMail(before, advanceLine(before, { a: p("done") }, 900))).toBe(false);
  });
});

describe("linePercentShown", () => {
  it("shows the percentage only once a visible sync has run for a while", () => {
    const mails = p("syncing_mails", { folder_index: 0, folder_count: 2, folder_done: 5, folder_total: 10 });
    const state = run([[0, { a: p("connecting") }], [500, { a: mails }]]);
    expect(linePercentShown(state.a, 500)).toBeNull();
    expect(linePercentShown(state.a, PERCENT_AFTER_MS)).toBe(25);
  });

  it("wakes up when the percentage is due", () => {
    const state = run([[0, { a: p("connecting") }], [500, { a: p("syncing_folders") }]]);
    expect(nextDeadline(state, 500)).toBe(PERCENT_AFTER_MS - 500);
  });
});

describe("nextDeadline", () => {
  it("wakes up for the reveal, the end of the linger and the end of the chip", () => {
    const pending = run([[0, { a: p("connecting") }]]);
    expect(nextDeadline(pending, 100)).toBe(REVEAL_MS - 100);

    const finished = run([[0, { a: p("connecting") }], [800, { a: p("syncing_folders") }], [1000, { a: p("done") }]]);
    expect(nextDeadline(finished, 1000)).toBe(LINGER_MS);
    expect(nextDeadline(finished, 1000 + LINGER_MS)).toBe(CHIP_MS - LINGER_MS);
    expect(nextDeadline(finished, 1000 + CHIP_MS)).toBeNull();
  });
});
