import { describe, it, expect } from "vitest";
import { findMeetingLink, linkify } from "./meetingLinks";

describe("findMeetingLink", () => {
  it("finds Teams, Zoom and Meet links across several texts", () => {
    expect(findMeetingLink("", null, "Join https://teams.microsoft.com/l/meetup-join/19%3a1 now.")).toBe("https://teams.microsoft.com/l/meetup-join/19%3a1");
    expect(findMeetingLink("https://us02web.zoom.us/j/88?pwd=x.")).toBe("https://us02web.zoom.us/j/88?pwd=x");
    expect(findMeetingLink("(https://meet.google.com/abc-defg-hij)")).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("ignores ordinary links and plain http", () => {
    expect(findMeetingLink("https://example.com/zoom.us")).toBeNull();
    expect(findMeetingLink("http://meet.google.com/abc")).toBeNull();
  });
});

describe("linkify", () => {
  it("splits text into text and link parts", () => {
    expect(linkify("See https://example.com/a, then call.")).toEqual([
      { kind: "text", text: "See " },
      { kind: "link", text: "https://example.com/a", href: "https://example.com/a" },
      { kind: "text", text: ", then call." },
    ]);
    expect(linkify("no links")).toEqual([{ kind: "text", text: "no links" }]);
  });
});
