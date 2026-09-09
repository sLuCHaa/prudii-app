import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import { TaskBoard } from "./TaskBoard";
import type { Task } from "../../types";

function makeTask(overrides: Partial<Task> & Pick<Task, "id" | "title" | "status">): Task {
  return {
    description_html: "",
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

const TASKS: Task[] = [
  makeTask({ id: "a", title: "Alpha", status: "open", sort_order: 0 }),
  makeTask({ id: "b", title: "Beta", status: "open", sort_order: 1 }),
  makeTask({ id: "c", title: "Gamma", status: "done", sort_order: 0 }),
];

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient();
  useAppStore.setState({ openTaskId: null });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
});

function renderBoard(tasks: Task[], allTasks: Task[] = tasks) {
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(TaskBoard, { tasks, allTasks })),
    );
  });
}

function findByText(tag: string, text: string): Element {
  const el = Array.from(document.querySelectorAll(tag)).find((node) => node.textContent === text);
  if (!el) throw new Error(`no <${tag}> with text "${text}"`);
  return el;
}

describe("TaskBoard", () => {
  it("renders three status columns and sorts tasks into the right one", () => {
    renderBoard(TASKS);

    const columns = document.querySelectorAll("[data-status]");
    expect(columns.length).toBe(3);
    expect(Array.from(columns).map((c) => c.getAttribute("data-status"))).toEqual(["open", "in_progress", "done"]);

    const openColumn = document.querySelector('[data-status="open"]')!;
    expect(openColumn.textContent).toContain("Alpha");
    expect(openColumn.textContent).toContain("Beta");
    expect(openColumn.textContent).not.toContain("Gamma");

    const inProgressColumn = document.querySelector('[data-status="in_progress"]')!;
    expect(inProgressColumn.textContent).not.toContain("Alpha");
    expect(inProgressColumn.textContent).not.toContain("Gamma");

    const doneColumn = document.querySelector('[data-status="done"]')!;
    expect(doneColumn.textContent).toContain("Gamma");
    expect(doneColumn.textContent).not.toContain("Alpha");
  });

  it("marks no column as a drop target while nothing is being dragged", () => {
    renderBoard(TASKS);

    expect(document.querySelectorAll("[data-drop-target]").length).toBe(0);
    // The dashed placeholder is the dragged card's own gap; at rest every card is real.
    expect(document.querySelectorAll(".border-dashed").length).toBe(0);
  });

  it("opens the task drawer when a card is clicked", () => {
    renderBoard(TASKS);

    act(() => {
      (findByText("p", "Alpha") as HTMLElement).click();
    });

    expect(useAppStore.getState().openTaskId).toBe("a");
  });
});

describe("TaskBoard — all tasks done", () => {
  const ALL_DONE: Task[] = [makeTask({ id: "z", title: "Zeta", status: "done", sort_order: 0 })];

  it("keeps the done column instead of replacing the whole board", () => {
    renderBoard(ALL_DONE);

    const columns = document.querySelectorAll("[data-status]");
    expect(columns.length).toBe(1);
    expect(columns[0].getAttribute("data-status")).toBe("done");
    expect(columns[0].textContent).toContain("Zeta");
    expect(document.body.textContent).toContain("All done");
  });

  it("does not fire the completion confetti on initial mount", () => {
    renderBoard(ALL_DONE);

    // CelebrationConfetti only renders a wrapper once a burst exists (z-index 1000);
    // an already-all-done board must not trigger one just by mounting.
    const confettiWrapper = Array.from(document.querySelectorAll<HTMLElement>("[aria-hidden]")).find(
      (el) => el.style.zIndex === "1000",
    );
    expect(confettiWrapper).toBeUndefined();
  });
});
