import { describe, it, expect } from "vitest";
import { looksLikeFeedLink, refreshLabelKey, syncState } from "./subscriptions";

describe("refreshLabelKey", () => {
  it("names each interval and falls back to hourly", () => {
    expect(refreshLabelKey(15)).toBe("calendar.refresh.m15");
    expect(refreshLabelKey(360)).toBe("calendar.refresh.h6");
    expect(refreshLabelKey(1440)).toBe("calendar.refresh.d1");
    expect(refreshLabelKey(7)).toBe("calendar.refresh.h1");
  });
});

describe("looksLikeFeedLink", () => {
  it("accepts https and webcal links with a host", () => {
    expect(looksLikeFeedLink("webcal://p01-caldav.icloud.com/published/2/abc")).toBe(true);
    expect(looksLikeFeedLink("  https://calendar.google.com/calendar/ical/x/basic.ics ")).toBe(true);
    expect(looksLikeFeedLink("WEBCALS://example.com/cal.ics")).toBe(true);
    expect(looksLikeFeedLink("https://nas/calendar.ics")).toBe(true);
  });

  it("rejects plain http, bare words and empty hosts", () => {
    expect(looksLikeFeedLink("http://example.com/cal.ics")).toBe(false);
    expect(looksLikeFeedLink("calendar")).toBe(false);
    expect(looksLikeFeedLink("https://")).toBe(false);
  });
});

describe("syncState", () => {
  it("tells never, ok and error apart", () => {
    expect(syncState({ last_synced_at: null, last_error: null })).toEqual({ kind: "never" });
    expect(syncState({ last_synced_at: "2026-10-16T12:00:00Z", last_error: null })).toEqual({
      kind: "ok",
      at: new Date("2026-10-16T12:00:00Z"),
    });
    expect(syncState({ last_synced_at: "2026-10-16T12:00:00Z", last_error: "calendar.errors.feedUnreachable" })).toEqual({
      kind: "error",
      error: "calendar.errors.feedUnreachable",
      lastOk: new Date("2026-10-16T12:00:00Z"),
    });
    expect(syncState({ last_synced_at: null, last_error: "calendar.errors.linkMissing" })).toEqual({
      kind: "error",
      error: "calendar.errors.linkMissing",
      lastOk: null,
    });
  });
});
