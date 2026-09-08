import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../lib/i18n";
import { DialogProvider } from "../ui/DialogProvider";
import { TaskDrawer } from "./TaskDrawer";

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
});

// onCreate/onUpdate override the real hooks (see TaskDrawer props) — a mocked
// tauri.ts leaked into unrelated UI tests before, so this drawer is designed
// to be testable through props instead.
function renderDrawer(props: { onClose?: () => void; onCreate?: (input: { title: string }) => void } = {}) {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          DialogProvider,
          null,
          createElement(TaskDrawer, { taskId: "new", onClose: props.onClose ?? (() => {}), onCreate: props.onCreate }),
        ),
      ),
    );
  });
}

describe("TaskDrawer — new task", () => {
  it("autofocuses the title input", () => {
    renderDrawer();
    const input = host.querySelector("input");
    expect(input).not.toBeNull();
    expect(document.activeElement).toBe(input);
  });

  it("creates the task with the trimmed title on Enter", () => {
    const onCreate = vi.fn();
    renderDrawer({ onCreate });
    const input = host.querySelector("input") as HTMLInputElement;

    act(() => {
      input.value = "  Buy milk  ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    expect(onCreate).toHaveBeenCalledTimes(1);
    expect(onCreate).toHaveBeenCalledWith({ title: "Buy milk" });
  });

  it("does not create a task for a blank title", () => {
    const onCreate = vi.fn();
    renderDrawer({ onCreate });
    const input = host.querySelector("input") as HTMLInputElement;

    act(() => {
      input.value = "   ";
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    });

    expect(onCreate).not.toHaveBeenCalled();
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("closes on an outside click", () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });

    act(() => {
      document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not close on a click inside the drawer", () => {
    const onClose = vi.fn();
    renderDrawer({ onClose });
    const input = host.querySelector("input") as HTMLInputElement;

    act(() => {
      input.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
  });
});
