import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../lib/i18n";
import type { Task } from "../../types";
import { TaskPickerDialog } from "./TaskPickerDialog";

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Task",
    description_html: "",
    status: "open",
    priority: "normal",
    due_at: null,
    sort_order: 0,
    reminder_sent: false,
    created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z",
    completed_at: null,
    checklist_done: 0,
    checklist_total: 0,
    link_count: 0,
    attachment_count: 0,
    ...overrides,
  };
}

const TASKS = [
  makeTask({ id: "a", title: "Invoice check" }),
  makeTask({ id: "b", title: "Call Bob", status: "in_progress" }),
  makeTask({ id: "c", title: "Archive invoices", status: "done" }),
];

// `tasks` overrides the real hook (see TaskPickerDialog props) — a mocked
// tauri.ts leaked into unrelated UI tests before, so the dialog takes props.
function renderDialog(props: { onPick?: (id: string) => void; onClose?: () => void; excludeTaskIds?: string[]; tasks?: Task[] } = {}) {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TaskPickerDialog, {
          open: true,
          onClose: props.onClose ?? (() => {}),
          onPick: props.onPick ?? (() => {}),
          excludeTaskIds: props.excludeTaskIds,
          tasks: props.tasks ?? TASKS,
        }),
      ),
    );
  });
}

function options(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[role='option']"));
}

function type(value: string) {
  const input = document.querySelector("input") as HTMLInputElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function press(key: string) {
  const input = document.querySelector("input") as HTMLInputElement;
  act(() => {
    input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

describe("TaskPickerDialog", () => {
  it("lists only tasks that are not done", () => {
    renderDialog();
    expect(options().map((o) => o.textContent)).toEqual(["Invoice check", "Call Bob"]);
  });

  it("leaves out already linked tasks", () => {
    renderDialog({ excludeTaskIds: ["a"] });
    expect(options().map((o) => o.textContent)).toEqual(["Call Bob"]);
  });

  it("filters by the search term", () => {
    renderDialog();
    type("bob");
    expect(options().map((o) => o.textContent)).toEqual(["Call Bob"]);
  });

  it("shows the empty state when nothing matches", () => {
    renderDialog();
    type("zzz");
    expect(options()).toHaveLength(0);
    expect(document.body.textContent).toContain("No open tasks");
  });

  it("picks the highlighted entry on Enter", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onPick, onClose });

    press("ArrowDown");
    press("Enter");

    expect(onPick).toHaveBeenCalledWith("b");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("picks the first match after searching", () => {
    const onPick = vi.fn();
    renderDialog({ onPick });

    press("ArrowDown");
    type("invoice");
    press("Enter");

    expect(onPick).toHaveBeenCalledWith("a");
  });

  it("wraps the selection at the list ends", () => {
    const onPick = vi.fn();
    renderDialog({ onPick });

    press("ArrowUp");
    press("Enter");

    expect(onPick).toHaveBeenCalledWith("b");
  });

  it("closes on Escape without picking", () => {
    const onPick = vi.fn();
    const onClose = vi.fn();
    renderDialog({ onPick, onClose });

    press("Escape");

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("keeps plain key presses inside the modal", () => {
    renderDialog();
    const seen: string[] = [];
    const listener = (e: Event) => seen.push((e as KeyboardEvent).key);
    window.addEventListener("keydown", listener);
    try {
      press("a");
      press("Delete");
    } finally {
      window.removeEventListener("keydown", listener);
    }
    expect(seen).toEqual([]);
  });

  it("still picks the last entry when the list shrinks under the highlight", () => {
    const onPick = vi.fn();
    renderDialog({ onPick });
    press("ArrowDown");

    // A refetch while the dialog is open can drop the highlighted task.
    renderDialog({ onPick, tasks: [TASKS[0]] });

    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    press("Enter");
    expect(onPick).toHaveBeenCalledWith("a");
  });

  it("does not pick anything when the list is empty", () => {
    const onPick = vi.fn();
    renderDialog({ onPick, tasks: [] });

    press("Enter");

    expect(onPick).not.toHaveBeenCalled();
  });
});
