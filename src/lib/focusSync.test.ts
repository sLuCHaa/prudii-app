import { describe, it, expect } from "vitest";
import { focusSyncStep, INITIAL_FOCUS_SYNC_STATE } from "./focusSync";

const MIN = 60_000;

describe("focusSyncStep", () => {
  it("records the blur time and never syncs on blur", () => {
    const r = focusSyncStep(INITIAL_FOCUS_SYNC_STATE, false, 1_000, MIN);
    expect(r.sync).toBe(false);
    expect(r.state.blurredAt).toBe(1_000);
  });

  it("does not sync when focus returns quickly", () => {
    const blurred = focusSyncStep(INITIAL_FOCUS_SYNC_STATE, false, 1_000, MIN).state;
    const r = focusSyncStep(blurred, true, 1_000 + MIN - 1, MIN);
    expect(r.sync).toBe(false);
    expect(r.state.blurredAt).toBeNull();
  });

  it("syncs when the window was away long enough", () => {
    const blurred = focusSyncStep(INITIAL_FOCUS_SYNC_STATE, false, 1_000, MIN).state;
    const r = focusSyncStep(blurred, true, 1_000 + MIN, MIN);
    expect(r.sync).toBe(true);
    expect(r.state.blurredAt).toBeNull();
  });

  it("ignores a focus event without a preceding blur (startup)", () => {
    const r = focusSyncStep(INITIAL_FOCUS_SYNC_STATE, true, 5_000, MIN);
    expect(r.sync).toBe(false);
  });

  it("does not start the away timer when focus moves to one of our own windows", () => {
    const r = focusSyncStep(INITIAL_FOCUS_SYNC_STATE, false, 1_000, MIN, true);
    expect(r.sync).toBe(false);
    expect(r.state.blurredAt).toBeNull();
  });

  it("does not sync when returning from one of our own windows", () => {
    const blurred = focusSyncStep(INITIAL_FOCUS_SYNC_STATE, false, 1_000, MIN, true).state;
    const r = focusSyncStep(blurred, true, 1_000 + 10 * MIN, MIN);
    expect(r.sync).toBe(false);
  });

  it("still syncs when returning from another app", () => {
    const blurred = focusSyncStep(INITIAL_FOCUS_SYNC_STATE, false, 1_000, MIN, false).state;
    const r = focusSyncStep(blurred, true, 1_000 + MIN, MIN);
    expect(r.sync).toBe(true);
  });

  it("keeps a running away timer when a compose window takes focus afterwards", () => {
    const blurred = focusSyncStep(INITIAL_FOCUS_SYNC_STATE, false, 1_000, MIN).state;
    const stillAway = focusSyncStep(blurred, false, 2_000, MIN, true).state;
    expect(stillAway.blurredAt).toBe(1_000);
  });

  it("keeps the first blur time across repeated blur events", () => {
    const a = focusSyncStep(INITIAL_FOCUS_SYNC_STATE, false, 1_000, MIN).state;
    const b = focusSyncStep(a, false, 2_000, MIN).state;
    expect(b.blurredAt).toBe(1_000);
  });
});
