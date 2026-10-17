import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switch } from "./Switch";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

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

describe("Switch", () => {
  it("renders an accessible switch button", () => {
    const h = html(createElement(Switch, { checked: true, onChange: () => {} }));
    expect(h).toContain('role="switch"');
    expect(h).toContain('aria-checked="true"');
    expect(h).toContain('type="button"');
    expect(h).toContain("switch-track");
  });

  it("reports the flipped value on click", () => {
    const onChange = vi.fn();
    const c = mount(createElement(Switch, { checked: true, onChange }));
    act(() => c.querySelector("button")!.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(false);
  });

  it("does not toggle when disabled", () => {
    const onChange = vi.fn();
    const c = mount(createElement(Switch, { checked: false, onChange, disabled: true }));
    act(() => c.querySelector("button")!.click());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("toggles once when its wrapping label is clicked", () => {
    const onChange = vi.fn();
    const c = mount(
      createElement("label", null, createElement("span", null, "Titel"), createElement(Switch, { checked: false, onChange })),
    );
    act(() => c.querySelector("span")!.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
