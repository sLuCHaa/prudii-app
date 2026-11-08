import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useDelayedFlag } from "./useDelayedFlag";

let latest = false;
function Harness({ flag }: { flag: boolean }) {
  latest = useDelayedFlag(flag, 150);
  return null;
}

let root: Root;
let host: HTMLDivElement;
const render = (flag: boolean) => act(() => root.render(createElement(Harness, { flag })));
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe("useDelayedFlag", () => {
  it("turns true after the delay", () => {
    render(true);
    advance(149);
    expect(latest).toBe(false);
    advance(1);
    expect(latest).toBe(true);
  });

  it("stays false when the flag drops before the delay", () => {
    render(true);
    advance(100);
    render(false);
    advance(200);
    expect(latest).toBe(false);
  });

  it("drops at once", () => {
    render(true);
    advance(200);
    expect(latest).toBe(true);
    render(false);
    expect(latest).toBe(false);
  });
});
