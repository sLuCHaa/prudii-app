import { describe, it, expect } from "vitest";
import { makeIsOutgoing } from "./outgoing";
import type { Folder, Mail } from "../types";

const folders = [
  { id: "inbox", folder_type: "inbox" },
  { id: "sent", folder_type: "sent" },
  { id: "drafts", folder_type: "drafts" },
] as Folder[];
const mail = (folder_id: string, email: string) => ({ folder_id, from: { name: "", email } }) as Mail;

describe("makeIsOutgoing", () => {
  it("treats sent and draft folders as outgoing", () => {
    const isOutgoing = makeIsOutgoing(folders, [], null);
    expect(isOutgoing(mail("sent", "x@y.de"))).toBe(true);
    expect(isOutgoing(mail("drafts", "x@y.de"))).toBe(true);
    expect(isOutgoing(mail("inbox", "x@y.de"))).toBe(false);
  });

  it("treats mail from an own address as outgoing, ignoring case", () => {
    expect(makeIsOutgoing(folders, ["Me@X.de"], null)(mail("inbox", "me@x.de"))).toBe(true);
  });

  it("treats every row of the combined sent view as outgoing", () => {
    expect(makeIsOutgoing([], [], "sent")(mail("other-account-sent", "alias@y.de"))).toBe(true);
    expect(makeIsOutgoing([], [], "trash")(mail("t", "x@y.de"))).toBe(false);
  });
});
