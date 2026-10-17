import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SegmentedControl } from "./SegmentedControl";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

const options = [
  { value: "a", label: "A" },
  { value: "b", label: "B" },
];

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(el: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(el));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("SegmentedControl", () => {
  it("marks only the chosen option as pressed", () => {
    const h = html(createElement(SegmentedControl, { options, value: "b", onChange: () => {} }));
    expect(h).toContain('role="group"');
    expect(h).toContain("segmented-track");
    expect(h).toContain("segmented-item");
    expect(h.match(/aria-pressed="true"/g)?.length).toBe(1);
  });

  it("reports the clicked option", () => {
    const onChange = vi.fn();
    const c = mount(createElement(SegmentedControl, { options, value: "b", onChange }));
    act(() => c.querySelectorAll("button")[0].click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith("a");
  });
});
