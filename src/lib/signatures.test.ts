import { describe, it, expect } from "vitest";
import { draftOf, isDraftDirty, sortSignatures, usesOther } from "./signatures";
import type { Signature } from "../types";

describe("signature order", () => {
  const named = (name: string): Signature => ({ id: name, name, html: "", text: "", created_at: "", updated_at: "" });

  it("sorts umlauts with their base letter and ignores case", () => {
    const sorted = sortSignatures(["Zebra", "Ärzte", "anna", "Österreich", "Privat"].map(named), "de");
    expect(sorted.map((s) => s.name)).toEqual(["anna", "Ärzte", "Österreich", "Privat", "Zebra"]);
  });

  it("puts numbers in numeric order and leaves the given list untouched", () => {
    const given = ["Büro 10", "Büro 2"].map(named);
    expect(sortSignatures(given, "de").map((s) => s.name)).toEqual(["Büro 2", "Büro 10"]);
    expect(given.map((s) => s.name)).toEqual(["Büro 10", "Büro 2"]);
  });
});

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
