import { describe, it, expect } from "vitest";
import { cardMode, conflictLine, originalTime, replyMail, statusKey } from "./invitation";

const t = (key: string, opts?: Record<string, unknown>) => (opts ? `${key}|${JSON.stringify(opts)}` : key);

describe("cardMode", () => {
  const v = { method: "REQUEST", outdated: false, organizer_is_me: false };
  it("answers fresh requests and flags outdated ones", () => {
    expect(cardMode(v)).toBe("request");
    expect(cardMode({ ...v, outdated: true })).toBe("outdated");
  });
  it("shows cancellations, publications and anything else", () => {
    expect(cardMode({ ...v, method: "CANCEL" })).toBe("cancel");
    expect(cardMode({ ...v, method: "PUBLISH" })).toBe("publish");
    expect(cardMode({ ...v, method: "COUNTER" })).toBe("info");
    expect(cardMode({ ...v, organizer_is_me: true })).toBe("info");
  });
});

describe("replyMail", () => {
  it("builds subject and body and appends a trimmed comment", () => {
    expect(replyMail(t, "accepted", "Review", null)).toEqual({
      subject: 'calendar.invite.replySubject.accepted|{"title":"Review"}',
      body: 'calendar.invite.replyBody.accepted|{"title":"Review"}',
    });
    expect(replyMail(t, "declined", "Review", "  Sorry, travelling ").body).toBe(
      'calendar.invite.replyBody.declined|{"title":"Review"}\n\nSorry, travelling',
    );
  });
  it("names untitled events", () => {
    expect(replyMail(t, "tentative", "  ", null).subject).toBe('calendar.invite.replySubject.tentative|{"title":"calendar.untitled"}');
  });
});

describe("originalTime", () => {
  const when = { all_day: false, start: "2026-10-20T07:00:00Z", end: "2026-10-20T08:00:00Z" };
  it("shows the organizer's clock when it reads differently", () => {
    expect(originalTime(when, "Europe/Berlin", "America/New_York", "en", true)).toBe("09:00 – 10:00 (Europe/Berlin)");
  });
  it("stays quiet for the same clock, UTC, all-day and unknown zones", () => {
    expect(originalTime(when, "Europe/Berlin", "Europe/Berlin", "en", true)).toBeNull();
    expect(originalTime(when, "Europe/Paris", "Europe/Berlin", "en", true)).toBeNull();
    expect(originalTime(when, "UTC", "Europe/Berlin", "en", true)).toBeNull();
    expect(originalTime({ ...when, all_day: true }, "Europe/Berlin", "America/New_York", "en", true)).toBeNull();
    expect(originalTime(when, "Not/AZone", "America/New_York", "en", true)).toBeNull();
  });
});

describe("statusKey", () => {
  it("maps answers to their status line", () => {
    expect(statusKey("accepted")).toBe("calendar.invite.status.accepted");
    expect(statusKey("needs-action")).toBe("calendar.invite.status.needsAction");
    expect(statusKey("delegated")).toBeNull();
    expect(statusKey(null)).toBeNull();
  });
});

describe("conflictLine", () => {
  it("names the overlapping events and counts the rest", () => {
    expect(conflictLine(t, [], 0)).toBeNull();
    expect(conflictLine(t, ["A", ""], 2)).toBe('calendar.invite.conflicts|{"titles":"A, calendar.untitled"}');
    expect(conflictLine(t, ["A", "B", "C"], 5)).toBe('calendar.invite.conflicts|{"titles":"A, B, C calendar.more|{\\"count\\":2}"}');
  });
});
