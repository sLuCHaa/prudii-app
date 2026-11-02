import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useLoadingHold } from "./useLoadingHold";

const seen: boolean[] = [];

function Harness({ loading, id }: { loading: boolean; id: string }) {
  seen.push(useLoadingHold(loading, id, 250));
  return null;
}

function mount() {
  const host = document.createElement("div");
  const root: Root = createRoot(host);
  const render = (loading: boolean, id: string) => act(() => root.render(createElement(Harness, { loading, id })));
  return { render, unmount: () => act(() => root.unmount()) };
}

const last = () => seen[seen.length - 1];

beforeEach(() => {
  seen.length = 0;
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

describe("useLoadingHold", () => {
  it("holds while loading, until the time is up", () => {
    const { render, unmount } = mount();
    render(true, "a");
    expect(last()).toBe(true);
    act(() => vi.advanceTimersByTime(249));
    expect(last()).toBe(true);
    act(() => vi.advanceTimersByTime(1));
    expect(last()).toBe(false);
    unmount();
  });

  it("releases as soon as loading ends", () => {
    const { render, unmount } = mount();
    render(true, "a");
    render(false, "a");
    expect(last()).toBe(false);
    unmount();
  });

  it("starts a new hold for the next item", () => {
    const { render, unmount } = mount();
    render(true, "a");
    act(() => vi.advanceTimersByTime(300));
    expect(last()).toBe(false);
    render(true, "b");
    expect(last()).toBe(true);
    unmount();
  });

  it("never holds when nothing is loading", () => {
    const { render, unmount } = mount();
    render(false, "a");
    expect(last()).toBe(false);
    unmount();
  });
});
