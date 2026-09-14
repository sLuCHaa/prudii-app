import { describe, it, expect } from "vitest";
import { memberLabel, sortRoster, indexAssignments, openAssignedTo, newlyAssigned, isSnapshotFresh } from "./team";
import type { TeamMember, Assignment } from "../types";

const m = (o: Partial<TeamMember>): TeamMember => ({ id: "x", user_id: "u", email: "u@x.de", name: "", role: "member", status: "active", online: false, last_seen: "", ...o });
const a = (o: Partial<Assignment>): Assignment => ({ id: "a", message_id: "<m>", account_email: "s@x.de", subject: "", assigned_by: "u1", assigned_to: "u2", status: "open", note: "", created: "", updated: "", ...o });

describe("memberLabel", () => {
  it("prefers the name and falls back to the local part of the email", () => {
    expect(memberLabel(m({ name: "Anna Muster" }))).toBe("Anna Muster");
    expect(memberLabel(m({ email: "paula@firma.de" }))).toBe("paula");
  });
});

describe("sortRoster", () => {
  it("puts me first, then online members, then alphabetical", () => {
    const r = sortRoster([m({ user_id: "b", email: "b@x.de" }), m({ user_id: "c", email: "c@x.de", online: true }), m({ user_id: "me", email: "z@x.de" })], "me");
    expect(r.map((x) => x.user_id)).toEqual(["me", "c", "b"]);
  });
});

describe("assignments", () => {
  it("indexes by message id and lists open ones assigned to me", () => {
    const list = [a({ id: "1", message_id: "<1>", assigned_to: "me" }), a({ id: "2", message_id: "<2>", assigned_to: "me", status: "done" }), a({ id: "3", message_id: "<3>" })];
    expect(indexAssignments(list).get("<2>")?.id).toBe("2");
    expect(openAssignedTo(list, "me").map((x) => x.id)).toEqual(["1"]);
  });

  it("detects assignments that newly target me", () => {
    const prev = [a({ id: "1", assigned_to: "me" })];
    const next = [a({ id: "1", assigned_to: "me" }), a({ id: "2", message_id: "<2>", assigned_to: "me" }), a({ id: "3", message_id: "<3>", assigned_to: "other" })];
    expect(newlyAssigned(prev, next, "me").map((x) => x.id)).toEqual(["2"]);
  });
});

describe("isSnapshotFresh", () => {
  it("treats a snapshot older than the presence ttl as stale", () => {
    expect(isSnapshotFresh(1000, 1000 + 179_000)).toBe(true);
    expect(isSnapshotFresh(1000, 1000 + 181_000)).toBe(false);
    expect(isSnapshotFresh(0, 5)).toBe(false);
  });
});
