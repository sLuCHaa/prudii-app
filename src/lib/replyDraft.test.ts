import { describe, it, expect } from "vitest";
import { replyRecipientDraft } from "./replyDraft";

describe("replyRecipientDraft", () => {
  it("returns the name of a sender without an address", () => {
    expect(replyRecipientDraft({ name: "Helga Brandt", email: "" })).toBe("Helga Brandt");
  });

  it("returns the name when the address is unusable", () => {
    expect(replyRecipientDraft({ name: "Helga", email: "kaputt" })).toBe("Helga");
  });

  it("returns null when there is a usable address", () => {
    expect(replyRecipientDraft({ name: "Helga Brandt", email: "helga.brandt@posteo.example" })).toBeNull();
  });

  it("returns null when there is nothing to keep", () => {
    expect(replyRecipientDraft({ name: "", email: "" })).toBeNull();
  });
});
