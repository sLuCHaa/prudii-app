import { describe, it, expect } from "vitest";
import { draftFromMail } from "./fromMail";

describe("draftFromMail", () => {
  it("prefills title, notes and the next full hour", () => {
    const now = new Date(2026, 9, 15, 10, 20);
    const draft = draftFromMail({ subject: "  Project kickoff ", snippet: "Let's meet next week " }, now);
    expect(draft.title).toBe("Project kickoff");
    expect(draft.description).toBe("Let's meet next week");
    expect(new Date(draft.times.start).getTime()).toBe(new Date(2026, 9, 15, 11, 0).getTime());
    expect(new Date(draft.times.end).getTime()).toBe(new Date(2026, 9, 15, 12, 0).getTime());
  });
});
