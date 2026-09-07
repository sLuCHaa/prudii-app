(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Select } from "./Select";

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
});

function key(k: string) {
  act(() => {
    document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true }));
  });
}

describe("Select", () => {
  it("opens a listbox on click, marks the selected option, and activates the other one with Enter", () => {
    const onChange = vi.fn();
    const options = [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ];
    act(() => root.render(createElement(Select, { value: "a", options, onChange })));

    const trigger = document.querySelector('[role="combobox"]') as HTMLButtonElement;
    act(() => trigger.click());

    expect(document.querySelector('[role="listbox"]')).not.toBeNull();
    const opts = document.querySelectorAll('[role="option"]');
    expect(opts.length).toBe(2);
    const selected = Array.from(opts).find((o) => o.textContent?.includes("Alpha"));
    expect(selected?.getAttribute("aria-selected")).toBe("true");

    key("ArrowDown"); // move focus to Beta
    key("Enter");

    expect(onChange).toHaveBeenCalledWith("b");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("opens with the current value's option focused, like a native select", () => {
    const onChange = vi.fn();
    const options = [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ];
    act(() => root.render(createElement(Select, { value: "b", options, onChange })));

    const trigger = document.querySelector('[role="combobox"]') as HTMLButtonElement;
    act(() => trigger.click());

    const opts = Array.from(document.querySelectorAll('[role="option"]'));
    const betaOption = opts.find((o) => o.textContent?.includes("Beta"));
    expect(document.activeElement).toBe(betaOption);
  });

  it("toggles the listbox closed when the open trigger is clicked again", () => {
    const onChange = vi.fn();
    const options = [
      { value: "a", label: "Alpha" },
      { value: "b", label: "Beta" },
    ];
    act(() => root.render(createElement(Select, { value: "a", options, onChange })));

    const trigger = document.querySelector('[role="combobox"]') as HTMLButtonElement;
    act(() => trigger.click());
    expect(document.querySelector('[role="listbox"]')).not.toBeNull();

    // A real second click fires mousedown (ContextMenu's outside-close listener)
    // then click (the trigger's own toggle) in the same gesture.
    act(() => {
      trigger.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      trigger.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });
});
