import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../lib/i18n";
import type { Task, TaskDetail, UpdateTaskPatch } from "../../types";
import { DialogProvider } from "../ui/DialogProvider";
import { TaskDrawer } from "./TaskDrawer";

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  // staleTime Infinity: seeded task detail must not trigger a background fetch
  // into the (unmocked) tauri bridge.
  queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
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

const TASK: Task = {
  id: "t1",
  title: "Follow up with Bangert",
  description_html: "",
  status: "in_progress",
  priority: "high",
  due_at: null,
  sort_order: 0,
  reminder_sent: false,
  created_at: "2026-09-01T08:00:00.000Z",
  updated_at: "2026-09-01T08:00:00.000Z",
  completed_at: null,
  checklist_done: 0,
  checklist_total: 0,
  link_count: 0,
  attachment_count: 0,
};

function renderExisting(
  onUpdate: (vars: { id: string; patch: UpdateTaskPatch }) => void,
  onClose: () => void = () => {},
) {
  const detail: TaskDetail = { task: TASK, checklist: [], links: [], attachments: [] };
  queryClient.setQueryData(["task", TASK.id], detail);
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(
          DialogProvider,
          null,
          createElement(TaskDrawer, { taskId: TASK.id, onClose, onUpdate }),
        ),
      ),
    );
  });
}

function pressEscape() {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
}

function buttonWithText(text: string): HTMLButtonElement {
  const match = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim().startsWith(text));
  if (!match) throw new Error(`no button starting with "${text}"`);
  return match as HTMLButtonElement;
}

function openDuePopover() {
  const chip = host.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement;
  expect(chip).not.toBeNull();
  act(() => chip.click());
  expect(host.querySelector('[role="dialog"]')).not.toBeNull();
}

describe("TaskDrawer — due popover", () => {
  it("sends a future due_at for a quick pick", () => {
    const onUpdate = vi.fn();
    renderExisting(onUpdate);
    openDuePopover();

    act(() => buttonWithText("Tomorrow").click());

    expect(onUpdate).toHaveBeenCalledTimes(1);
    const { id, patch } = onUpdate.mock.calls[0][0];
    expect(id).toBe(TASK.id);
    expect(patch.clear_due_at).toBeUndefined();
    expect(new Date(patch.due_at as string).getTime()).toBeGreaterThan(Date.now());
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("clears the due date via the no-date pick", () => {
    const onUpdate = vi.fn();
    renderExisting(onUpdate);
    openDuePopover();

    act(() => buttonWithText("No date").click());

    expect(onUpdate).toHaveBeenCalledWith({ id: TASK.id, patch: { clear_due_at: true } });
    expect(host.querySelector('[role="dialog"]')).toBeNull();
  });

  it("closes the popover on the first Escape and the drawer only on the second", () => {
    const onClose = vi.fn();
    renderExisting(vi.fn(), onClose);
    openDuePopover();

    pressEscape();
    expect(host.querySelector('[role="dialog"]')).toBeNull();
    expect(host.querySelector("textarea")).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    pressEscape();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores a mousedown inside a portaled listbox", () => {
    const onClose = vi.fn();
    renderExisting(vi.fn(), onClose);

    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    const option = document.createElement("div");
    listbox.appendChild(option);
    document.body.appendChild(listbox);

    act(() => {
      option.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });

    expect(onClose).not.toHaveBeenCalled();
    listbox.remove();
  });
});
