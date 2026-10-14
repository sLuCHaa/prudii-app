import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildListItems } from "./mailListItems";
import type { Mail } from "../types";

const mail = (id: string, date: string) => ({ id, date }) as Mail;
const labels = { today: "Today", older: "Older" };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-03-15T12:00:00Z"));
});
afterEach(() => vi.useRealTimers());

describe("buildListItems", () => {
  it("inserts a separator where the date group changes", () => {
    const items = buildListItems([mail("a", "2026-03-15T10:00:00Z"), mail("b", "2025-01-01T10:00:00Z")], labels, true);
    expect(items.map((i) => (i.kind === "separator" ? `sep:${i.group}` : i.mail.id))).toEqual(["sep:today", "a", "sep:older", "b"]);
  });

  it("leaves separators out for non-date sorts and keeps mail indexes", () => {
    const items = buildListItems([mail("a", "2026-03-15T10:00:00Z"), mail("b", "2025-01-01T10:00:00Z")], labels, false);
    expect(items).toEqual([
      { kind: "mail", mail: expect.objectContaining({ id: "a" }), mailIndex: 0 },
      { kind: "mail", mail: expect.objectContaining({ id: "b" }), mailIndex: 1 },
    ]);
  });
});
