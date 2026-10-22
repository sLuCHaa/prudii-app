import { describe, it, expect } from "vitest";
import { recipientSummary } from "./recipientSummary";

const anna = { name: "Anna Weber", email: "anna@studio-halde.example" };
const jonas = { name: "Jonas Berger", email: "jonas@studio-halde.example" };
const lea = { name: "", email: "lea@studio-halde.example" };

describe("recipientSummary", () => {
  it("returns the single recipient without a count", () => {
    expect(recipientSummary([anna], [])).toEqual({ first: "Anna Weber", more: 0 });
  });

  it("counts the remaining to and cc recipients", () => {
    expect(recipientSummary([anna, jonas], [lea])).toEqual({ first: "Anna Weber", more: 2 });
  });

  it("falls back to the email when the name is missing", () => {
    expect(recipientSummary([lea], [])).toEqual({ first: "lea@studio-halde.example", more: 0 });
  });

  it("uses the first cc entry when to is empty", () => {
    expect(recipientSummary([], [jonas, lea])).toEqual({ first: "Jonas Berger", more: 1 });
  });

  it("returns null without recipients", () => {
    expect(recipientSummary([], [])).toBeNull();
  });
});
