import { describe, it, expect } from "vitest";
import { draftOf, isDraftDirty, usesOther } from "./signatures";
import type { Signature } from "../types";

const S: Signature = { id: "s1", name: "Studio Halde", html: "<div>Anna Weber</div>", text: "Anna Weber", created_at: "", updated_at: "" };
const accounts = [
  { id: "a1", signature_id: "s1" },
  { id: "a2", signature_id: "s2" },
  { id: "a3", signature_id: null },
];

describe("signature drafts", () => {
  it("starts a draft from the stored signature and its accounts", () => {
    expect(draftOf(S, accounts)).toEqual({ id: "s1", name: "Studio Halde", html: S.html, text: S.text, accountIds: ["a1"] });
    expect(draftOf(null, accounts)).toEqual({ id: null, name: "", html: "", text: "", accountIds: [] });
  });

  it("is dirty only once something differs", () => {
    expect(isDraftDirty(draftOf(S, accounts), S, accounts)).toBe(false);
    expect(isDraftDirty({ ...draftOf(S, accounts), accountIds: ["a3", "a1"] }, S, accounts)).toBe(true);
    expect(isDraftDirty({ ...draftOf(S, accounts), name: "Studio Halde " }, S, accounts)).toBe(true);
    expect(isDraftDirty(draftOf(null, accounts), null, accounts)).toBe(false);
    expect(isDraftDirty({ ...draftOf(null, accounts), html: "<div>x</div>" }, null, accounts)).toBe(true);
  });

  it("ignores the order of ticked accounts", () => {
    const two = [
      { id: "a1", signature_id: "s1" },
      { id: "a2", signature_id: "s1" },
    ];
    expect(isDraftDirty({ ...draftOf(S, two), accountIds: ["a2", "a1"] }, S, two)).toBe(false);
  });

  it("names the other signature an account uses", () => {
    const all = [S, { ...S, id: "s2", name: "Privat" }];
    expect(usesOther(accounts[1], "s1", all)).toBe("Privat");
    expect(usesOther(accounts[0], "s1", all)).toBeNull();
    expect(usesOther(accounts[2], "s1", all)).toBeNull();
    expect(usesOther({ signature_id: "gone" }, "s1", all)).toBeNull();
  });
});
