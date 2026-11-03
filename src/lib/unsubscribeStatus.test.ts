import { describe, expect, it } from "vitest";
import { statusActions, statusLabel } from "./unsubscribeStatus";
import type { Unsubscription } from "../types";

const base: Unsubscription = {
  id: "u1",
  display_name: "Halde Shop",
  status: "waiting",
  requested_at: "2026-11-03T08:00:00Z",
  web_pending: false,
  quiet_days: 0,
  sorted_count: 0,
  can_retry: false,
};

const formatDate = () => "3. Nov.";

describe("statusLabel", () => {
  it("labels each status", () => {
    expect(statusLabel(base, formatDate)).toEqual({ key: "unsubscribe.status.waiting", options: { date: "3. Nov." } });
    expect(statusLabel({ ...base, web_pending: true }, formatDate).key).toBe("unsubscribe.status.webPending");
    expect(statusLabel({ ...base, status: "quiet", quiet_days: 12 }, formatDate)).toEqual({
      key: "unsubscribe.status.quiet",
      options: { count: 12 },
    });
    expect(statusLabel({ ...base, status: "still_sending", sorted_count: 4 }, formatDate)).toEqual({
      key: "unsubscribe.status.stillSending",
      options: { count: 4 },
    });
    expect(statusLabel({ ...base, status: "blocked", sorted_count: 2 }, formatDate)).toEqual({
      key: "unsubscribe.status.blocked",
      options: { count: 2 },
    });
  });
});

describe("statusActions", () => {
  it("offers retry only while still sending", () => {
    expect(statusActions({ ...base, status: "still_sending", can_retry: true })).toEqual(["retry", "allow"]);
    expect(statusActions({ ...base, status: "still_sending" })).toEqual(["allow"]);
    expect(statusActions(base)).toEqual(["allow"]);
  });
});
