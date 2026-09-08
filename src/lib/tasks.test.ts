import { describe, it, expect } from "vitest";
import { isOverdue, isDueToday, groupByStatus, fullColumnDropIndex, parseQuickAdd, chunkIds, mergeCounts } from "./tasks";
import type { Task } from "../types";

// Tuesday, Sept 8 2026, 10:00 local.
const now = new Date(2026, 8, 8, 10, 0);

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

describe("parseQuickAdd", () => {
  it("strips the date token and schedules tomorrow 09:00", () => {
    const r = parseQuickAdd("Rechnung prüfen morgen", now);
    expect(r.title).toBe("Rechnung prüfen");
    expect(new Date(r.dueAt!).getDate()).toBe(9);
    expect(new Date(r.dueAt!).getHours()).toBe(9);
  });

  it("understands english weekdays and explicit times", () => {
    const r = parseQuickAdd("Call Bob friday 14:30", now);
    expect(r.title).toBe("Call Bob");
    const d = new Date(r.dueAt!);
    expect(d.getDay()).toBe(5);
    expect(d.getHours()).toBe(14);
    expect(d.getMinutes()).toBe(30);
  });

  it("uses today 18:00 for 'heute', and today or tomorrow for a bare time", () => {
    expect(new Date(parseQuickAdd("x heute", now).dueAt!).getHours()).toBe(18);
    expect(new Date(parseQuickAdd("x 9 uhr", now).dueAt!).getDate()).toBe(9); // 09:00 already passed → tomorrow
    expect(new Date(parseQuickAdd("x 15:00", now).dueAt!).getDate()).toBe(8);
  });

  it("handles 'in 3 tagen' / 'in 2 weeks' and leaves plain titles alone", () => {
    expect(new Date(parseQuickAdd("x in 3 tagen", now).dueAt!).getDate()).toBe(11);
    expect(new Date(parseQuickAdd("x in 2 weeks", now).dueAt!).getDate()).toBe(22);
    expect(parseQuickAdd("Nur ein Titel", now)).toEqual({ title: "Nur ein Titel", dueAt: null });
  });

  it("schedules übermorgen two days out at 09:00", () => {
    const r = parseQuickAdd("Ticket übermorgen", now);
    expect(r.title).toBe("Ticket");
    const d = new Date(r.dueAt!);
    expect(d.getDate()).toBe(10);
    expect(d.getHours()).toBe(9);
  });

  it("trims trailing punctuation left behind after stripping a token", () => {
    expect(parseQuickAdd("Sachen erledigen, do", now).title).toBe("Sachen erledigen");
  });

  it("does not mangle a title where a short weekday token appears mid-sentence", () => {
    // "so" is a German short token for Sunday, but is not the last word here
    // and is not followed by a time token, so it must stay part of the title.
    const r = parseQuickAdd("Mach das so schnell", now);
    expect(r.title).toBe("Mach das so schnell");
    expect(r.dueAt).toBeNull();
  });
});

describe("isOverdue", () => {
  it("is true for a past due date on an open task", () => {
    expect(isOverdue({ due_at: "2026-09-01T00:00:00Z", status: "open" }, now)).toBe(true);
  });

  it("is never true for a done task, even with a past due date", () => {
    expect(isOverdue({ due_at: "2026-09-01T00:00:00Z", status: "done" }, now)).toBe(false);
  });

  it("is false for a future due date", () => {
    expect(isOverdue({ due_at: "2026-12-01T00:00:00Z", status: "open" }, now)).toBe(false);
  });
});

describe("isDueToday", () => {
  it("is true when due_at falls on the same local calendar day", () => {
    expect(isDueToday({ due_at: new Date(2026, 8, 8, 23, 0).toISOString() }, now)).toBe(true);
  });

  it("is false for a different day", () => {
    expect(isDueToday({ due_at: new Date(2026, 8, 9, 0, 0).toISOString() }, now)).toBe(false);
  });

  it("is false when there is no due date", () => {
    expect(isDueToday({ due_at: null }, now)).toBe(false);
  });
});

describe("groupByStatus", () => {
  it("groups tasks into their status buckets", () => {
    const tasks = [
      makeTask({ id: "a", status: "open", sort_order: 0 }),
      makeTask({ id: "b", status: "in_progress", sort_order: 0 }),
      makeTask({ id: "c", status: "done", sort_order: 0 }),
    ];
    const grouped = groupByStatus(tasks);
    expect(grouped.open.map((t) => t.id)).toEqual(["a"]);
    expect(grouped.in_progress.map((t) => t.id)).toEqual(["b"]);
    expect(grouped.done.map((t) => t.id)).toEqual(["c"]);
  });

  it("sorts each bucket by sort_order", () => {
    const tasks = [
      makeTask({ id: "a", status: "open", sort_order: 2 }),
      makeTask({ id: "b", status: "open", sort_order: 0 }),
      makeTask({ id: "c", status: "open", sort_order: 1 }),
    ];
    const grouped = groupByStatus(tasks);
    expect(grouped.open.map((t) => t.id)).toEqual(["b", "c", "a"]);
  });

  it("returns an empty array for a status with no tasks", () => {
    const grouped = groupByStatus([makeTask({ id: "a", status: "open" })]);
    expect(grouped.in_progress).toEqual([]);
    expect(grouped.done).toEqual([]);
  });
});

describe("fullColumnDropIndex", () => {
  // Full "open" column: a(0), b(1), c(2); "x" is the card being dropped into it.
  const all = [
    makeTask({ id: "a", status: "open", sort_order: 0 }),
    makeTask({ id: "b", status: "open", sort_order: 1 }),
    makeTask({ id: "c", status: "open", sort_order: 2 }),
    makeTask({ id: "x", status: "in_progress", sort_order: 0 }),
  ];

  it("keeps the visible index when nothing is filtered out", () => {
    const visible = [all[0], makeTask({ id: "x", status: "open" }), all[1], all[2]];
    expect(fullColumnDropIndex(all, "open", "x", visible)).toBe(1);
  });

  it("translates a drop below a filtered column to the position after its predecessor", () => {
    // Only "c" passes the filter; dropping below it must land after c, not at index 1.
    const visible = [all[2], makeTask({ id: "x", status: "open" })];
    expect(fullColumnDropIndex(all, "open", "x", visible)).toBe(3);
  });

  it("puts a drop above the first visible card at the top of the full column", () => {
    const visible = [makeTask({ id: "x", status: "open" }), all[2]];
    expect(fullColumnDropIndex(all, "open", "x", visible)).toBe(0);
  });

  it("appends when the card is not in the visible column and when its predecessor is gone", () => {
    expect(fullColumnDropIndex(all, "open", "x", [])).toBe(3);
    const stale = [makeTask({ id: "gone", status: "open" }), makeTask({ id: "x", status: "open" })];
    expect(fullColumnDropIndex(all, "open", "x", stale)).toBe(3);
  });

  it("ignores sort_order gaps and other columns", () => {
    const sparse = [
      makeTask({ id: "a", status: "open", sort_order: 5 }),
      makeTask({ id: "b", status: "open", sort_order: 1 }),
      makeTask({ id: "d", status: "done", sort_order: 0 }),
    ];
    const visible = [sparse[0], makeTask({ id: "x", status: "open" })];
    expect(fullColumnDropIndex(sparse, "open", "x", visible)).toBe(2);
  });
});

describe("chunkIds", () => {
  it("splits into batches of at most size", () => {
    expect(chunkIds(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  });

  it("keeps a shorter list in one batch", () => {
    expect(chunkIds(["a", "b"], 200)).toEqual([["a", "b"]]);
  });

  it("returns no batches for an empty list", () => {
    expect(chunkIds([], 200)).toEqual([]);
  });

  it("falls back to a single batch for a non-positive size", () => {
    expect(chunkIds(["a", "b"], 0)).toEqual([["a", "b"]]);
  });
});

describe("mergeCounts", () => {
  it("merges the counts of all chunks into one map", () => {
    expect(mergeCounts([{ a: 1 }, { b: 2, c: 3 }])).toEqual({ a: 1, b: 2, c: 3 });
  });

  it("does not add up a repeated id", () => {
    expect(mergeCounts([{ a: 2 }, { a: 2 }])).toEqual({ a: 2 });
  });

  it("returns an empty map without chunks", () => {
    expect(mergeCounts([])).toEqual({});
  });
});
