import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import "../../lib/i18n";
import type { CreateTaskInput } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { QuickAdd, type QuickAddProps } from "./QuickAdd";

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient();
  useAppStore.setState({ quickAddFocusRequested: false });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
});

// reducedMotion="always" makes every transition instant, so AnimatePresence's exit
// resolves synchronously inside act() instead of leaving the chip mid-fade forever.
function renderQuickAdd(props: QuickAddProps = {}) {
  act(() => {
    root.render(
      createElement(
        MotionConfig,
        { reducedMotion: "always" },
        createElement(
          QueryClientProvider,
          { client: queryClient },
          createElement(QuickAdd, props),
        ),
      ),
    );
  });
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressEnter(input: HTMLInputElement) {
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
}

describe("QuickAdd", () => {
  it("shows a live due-date preview chip while typing and hides it once cleared", () => {
    renderQuickAdd();
    const input = host.querySelector("input") as HTMLInputElement;

    type(input, "Call Bob tomorrow 9:00");
    expect(host.textContent).toContain("Tomorrow");

    type(input, "Call Bob");
    expect(host.textContent).not.toContain("Tomorrow");
  });

  it("creates the task with the parsed title and due date on Enter, then clears the input", () => {
    const onCreate = vi.fn();
    renderQuickAdd({ onCreate });
    const input = host.querySelector("input") as HTMLInputElement;

    type(input, "Call Bob tomorrow 9:00");
    pressEnter(input);

    expect(onCreate).toHaveBeenCalledTimes(1);
    const call = onCreate.mock.calls[0][0] as CreateTaskInput;
    expect(call.title).toBe("Call Bob");
    expect(typeof call.due_at).toBe("string");
    expect(new Date(call.due_at!).toISOString()).toBe(call.due_at);
    expect(input.value).toBe("");
  });

  it("does not create a task when the input parses to an empty title (date tokens only)", () => {
    const onCreate = vi.fn();
    renderQuickAdd({ onCreate });
    const input = host.querySelector("input") as HTMLInputElement;

    type(input, "morgen");
    pressEnter(input);

    expect(onCreate).not.toHaveBeenCalled();
    expect(input.getAttribute("aria-invalid")).toBe("true");
  });

  it("closes the popover variant on Escape instead of only clearing", () => {
    const onClose = vi.fn();
    renderQuickAdd({ onClose });
    const input = host.querySelector("input") as HTMLInputElement;
    type(input, "Something");

    act(() => {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("autofocuses when the store's quickAddFocusRequested flag is set, then consumes it", () => {
    useAppStore.setState({ quickAddFocusRequested: true });
    renderQuickAdd();
    const input = host.querySelector("input") as HTMLInputElement;

    expect(document.activeElement).toBe(input);
    expect(useAppStore.getState().quickAddFocusRequested).toBe(false);
  });

  it("does not autofocus on an ordinary mount when the flag is not set", () => {
    renderQuickAdd();
    const input = host.querySelector("input") as HTMLInputElement;
    expect(document.activeElement).not.toBe(input);
  });
});
