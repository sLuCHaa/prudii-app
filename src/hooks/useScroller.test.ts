import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useScroller } from "./useScroller";

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function List() {
  const { host, viewport } = useScroller();
  return createElement(
    "div",
    { ref: host },
    createElement("div", { ref: viewport, "data-testid": "viewport" }, createElement("p", null, "Anna Weber")),
  );
}

async function settle() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 50));
  });
}

describe("useScroller", () => {
  it("keeps its scrollbars out of the element that scrolls", async () => {
    act(() => root.render(createElement(List)));
    await settle();
    const viewport = container.querySelector("[data-testid=viewport]")!;
    expect(document.querySelector(".os-scrollbar")).not.toBeNull();
    expect(viewport.querySelector(".os-scrollbar")).toBeNull();
  });
});
