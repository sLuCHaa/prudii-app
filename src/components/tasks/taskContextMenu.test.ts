(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../../lib/i18n";
import type { Task, TaskStatus } from "../../types";
import { TASK_STATUSES } from "../../types";
import { STATUS_KEY } from "./TaskStatusBadge";
import { TaskContextMenu } from "./TaskContextMenu";

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

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "t1",
    title: "Rechnung prüfen",
    description_html: "",
    status: "open",
    priority: "normal",
    due_at: null,
    sort_order: 0,
    reminder_sent: false,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    completed_at: null,
    checklist_done: 0,
    checklist_total: 0,
    link_count: 0,
    attachment_count: 0,
    ...overrides,
  };
}

let opened: string[];
let statuses: [string, TaskStatus][];
let deleted: string[];
let closed: number;

function render(task: Task = makeTask()) {
  opened = [];
  statuses = [];
  deleted = [];
  closed = 0;
  act(() =>
    root.render(
      createElement(TaskContextMenu, {
        task,
        x: 10,
        y: 10,
        onClose: () => { closed += 1; },
        onOpen: (t: Task) => opened.push(t.id),
        onStatus: (t: Task, s: TaskStatus) => statuses.push([t.id, s]),
        onDelete: (t: Task) => deleted.push(t.id),
      }),
    ),
  );
}

/** Menu labels come from i18n, so look them up rather than hardcoding a language. */
function item(key: string): HTMLButtonElement | undefined {
  const label = i18n.t(key);
  return Array.from(document.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
}

describe("TaskContextMenu", () => {
  it("offers open, all three statuses and delete", () => {
    render();
    expect(item("tasks.openTask")).toBeTruthy();
    for (const status of TASK_STATUSES) {
      expect(item(STATUS_KEY[status]), `missing status "${status}"`).toBeTruthy();
    }
    expect(item("tasks.deleteTask")).toBeTruthy();
  });

  it("checks the status the task currently has, and only that one", () => {
    render(makeTask({ status: "in_progress" }));
    const checked = TASK_STATUSES.filter((s) => item(STATUS_KEY[s])?.querySelector("svg.text-accent"));
    expect(checked).toEqual(["in_progress"]);
  });

  it("reports the picked status", () => {
    render();
    act(() => item(STATUS_KEY.done)!.click());
    expect(statuses).toEqual([["t1", "done"]]);
  });

  it("still reports the current status so callers can no-op it themselves", () => {
    // Rendering it disabled would grey the row and read as "unavailable".
    render(makeTask({ status: "done" }));
    expect(item(STATUS_KEY.done)!.disabled).toBe(false);
    act(() => item(STATUS_KEY.done)!.click());
    expect(statuses).toEqual([["t1", "done"]]);
  });

  it("marks delete as destructive rather than burying it", () => {
    render();
    expect(item("tasks.deleteTask")!.className).toContain("text-danger");
  });

  it("reports open and delete", () => {
    render();
    act(() => item("tasks.openTask")!.click());
    expect(opened).toEqual(["t1"]);

    render();
    act(() => item("tasks.deleteTask")!.click());
    expect(deleted).toEqual(["t1"]);
  });

  it("closes after any action", () => {
    render();
    act(() => item("tasks.openTask")!.click());
    expect(closed).toBe(1);
  });
});
