import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../../lib/i18n";
import { PdfQuickView } from "./PdfQuickView";

let root: Root;
let host: HTMLDivElement;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  URL.createObjectURL = vi.fn((blob: Blob) => `blob:${(blob as Blob).size}`);
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

const items = [
  { id: "a", name: "angebot.pdf", data: btoa("%PDF-1"), size: 6 },
  { id: "b", name: "rechnung.pdf", data: btoa("%PDF-22"), size: 7 },
];

function render(onClose = () => {}) {
  act(() => root.render(createElement(PdfQuickView, { items, initialIndex: 0, onClose })));
}

function press(key: string) {
  act(() => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key }));
  });
}

describe("PdfQuickView", () => {
  it("shows the chosen PDF as a blob in a frame", () => {
    render();
    const frame = document.querySelector("iframe");
    expect(frame?.title).toBe("angebot.pdf");
    expect(frame?.getAttribute("src")).toBe("blob:6");
  });

  it("pages to the next PDF with the arrow key and frees the old blob", () => {
    render();
    press("ArrowRight");
    expect(document.querySelector("iframe")?.title).toBe("rechnung.pdf");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:6");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(onClose);
    press("Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
