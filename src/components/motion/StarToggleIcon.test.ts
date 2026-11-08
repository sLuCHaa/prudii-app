import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { StarToggleIcon } from "./StarToggleIcon";

let root: Root;
let host: HTMLDivElement;
let raf: ReturnType<typeof vi.fn>;
let caf: ReturnType<typeof vi.fn>;
const realMatchMedia = window.matchMedia;

const render = (starred: boolean) => act(() => root.render(createElement(StarToggleIcon, { starred, size: 14 })));

function reducedMotion(on: boolean) {
  window.matchMedia = ((query: string) => ({
    matches: on && query.includes("reduce"),
    media: query, onchange: null,
    addListener: () => {}, removeListener: () => {}, addEventListener: () => {}, removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

beforeEach(() => {
  raf = vi.fn(() => 1);
  caf = vi.fn();
  vi.stubGlobal("requestAnimationFrame", raf);
  vi.stubGlobal("cancelAnimationFrame", caf);
  reducedMotion(false);
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  window.matchMedia = realMatchMedia;
});

describe("StarToggleIcon", () => {
  it("does not animate on mount", () => {
    render(true);
    expect(raf).not.toHaveBeenCalled();
  });

  it("starts a frame when starred changes", () => {
    render(false);
    render(true);
    expect(raf).toHaveBeenCalled();
  });

  it("cancels the frame on unmount", () => {
    render(false);
    render(true);
    act(() => root.unmount());
    expect(caf).toHaveBeenCalled();
    root = createRoot(host);
  });

  it("skips the spin with reduced motion", () => {
    reducedMotion(true);
    render(false);
    render(true);
    expect(raf).not.toHaveBeenCalled();
    expect(host.querySelector(".star-toggle-fill")!.getAttribute("fill-opacity")).toBe("1");
  });
});
