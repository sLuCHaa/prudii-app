import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act, forwardRef, useImperativeHandle } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDebouncedCallback, type DebouncedCallback } from "./useDebouncedCallback";

interface Handle {
  debounced: DebouncedCallback<[string]>;
}

// A hook needs a component to run in — mount a throwaway one that exposes the
// debounced callback via ref, mirroring the render-into-a-host pattern used by
// the other DOM tests in this repo (no renderHook helper here).
const Harness = forwardRef<Handle, { fn: (value: string) => void; ms: number }>(({ fn, ms }, ref) => {
  const debounced = useDebouncedCallback(fn, ms);
  useImperativeHandle(ref, () => ({ debounced }), [debounced]);
  return null;
});

function mount(fn: (value: string) => void, ms: number) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root: Root = createRoot(host);
  const ref: { current: Handle | null } = { current: null };
  act(() => {
    root.render(createElement(Harness, { fn, ms, ref }));
  });
  return {
    debounced: ref.current!.debounced,
    unmount: () => act(() => root.unmount()),
    cleanup: () => host.remove(),
  };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("useDebouncedCallback", () => {
  it("coalesces rapid calls into one, after the delay, with the latest args", () => {
    const fn = vi.fn();
    const { debounced, unmount, cleanup } = mount(fn, 300);

    act(() => { debounced("a"); debounced("b"); debounced("c"); });
    act(() => vi.advanceTimersByTime(299));
    expect(fn).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(1));
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("c");

    unmount();
    cleanup();
  });

  it("flush() runs the pending call immediately and does not run it again later", () => {
    const fn = vi.fn();
    const { debounced, unmount, cleanup } = mount(fn, 300);

    act(() => debounced("x"));
    act(() => debounced.flush());
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("x");

    act(() => vi.advanceTimersByTime(1000));
    expect(fn).toHaveBeenCalledTimes(1);

    unmount();
    cleanup();
  });

  it("cancel() drops the pending call", () => {
    const fn = vi.fn();
    const { debounced, unmount, cleanup } = mount(fn, 300);

    act(() => debounced("x"));
    act(() => debounced.cancel());
    act(() => vi.advanceTimersByTime(1000));
    expect(fn).not.toHaveBeenCalled();

    unmount();
    cleanup();
  });

  it("flushes a pending call on unmount instead of dropping it, and not twice", () => {
    const fn = vi.fn();
    const { debounced, unmount, cleanup } = mount(fn, 300);

    act(() => debounced("typed then escape"));
    unmount();

    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith("typed then escape");

    act(() => vi.advanceTimersByTime(1000));
    expect(fn).toHaveBeenCalledTimes(1);

    cleanup();
  });

  it("does nothing on unmount when there is no pending call", () => {
    const fn = vi.fn();
    const { unmount, cleanup } = mount(fn, 300);

    unmount();
    expect(fn).not.toHaveBeenCalled();
    cleanup();
  });
});
