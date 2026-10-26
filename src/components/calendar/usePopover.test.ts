import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePopover } from "./usePopover";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.restoreAllMocks();
});

function Panel({ onClose }: { onClose: () => void }) {
  const { ref } = usePopover(new DOMRect(0, 0, 10, 10), onClose);
  return createElement("div", { ref }, createElement("a", { href: "https://booking.example/edit" }, "link"));
}

function renderPanel(onClose: () => void) {
  act(() => root.render(createElement(Panel, { onClose })));
}

describe("usePopover", () => {
  it("moves focus in without scrolling the panel", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    renderPanel(() => {});
    expect(document.activeElement).toBe(host.querySelector("a"));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("closes on an outside pointerdown whose mouse events are suppressed", () => {
    const onClose = vi.fn();
    renderPanel(onClose);
    const outside = document.createElement("div");
    document.body.appendChild(outside);
    outside.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    outside.remove();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("stays open on a pointerdown inside the panel", () => {
    const onClose = vi.fn();
    renderPanel(onClose);
    host.querySelector("a")!.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
