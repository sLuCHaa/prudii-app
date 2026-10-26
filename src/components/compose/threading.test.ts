import { describe, it, expect } from "vitest";
import type { Mail } from "../../types";
import { threadingHeaders } from "./threading";

const mail = (over: Partial<Mail>): Mail => ({ message_id: "", in_reply_to: null, references: "", ...over }) as Mail;

describe("threadingHeaders", () => {
  it("answers the original in a reply", () => {
    const original = mail({ message_id: "c@studio-halde.example", in_reply_to: "b@studio-halde.example", references: "a@studio-halde.example b@studio-halde.example" });
    expect(threadingHeaders("reply", original)).toEqual({
      in_reply_to: "c@studio-halde.example",
      references: "a@studio-halde.example b@studio-halde.example c@studio-halde.example",
    });
  });

  it("keeps a reopened draft's own threading instead of pointing at the draft", () => {
    const draft = mail({ message_id: "draft-1@studio-halde.example", in_reply_to: "b@studio-halde.example", references: "a@studio-halde.example b@studio-halde.example" });
    expect(threadingHeaders("draft", draft)).toEqual({
      in_reply_to: "b@studio-halde.example",
      references: "a@studio-halde.example b@studio-halde.example",
    });
  });

  it("leaves a reopened new-message draft unthreaded", () => {
    expect(threadingHeaders("draft", mail({ message_id: "draft-2@studio-halde.example" }))).toEqual({
      in_reply_to: undefined,
      references: undefined,
    });
  });

  it("falls back to In-Reply-To when a draft has no References", () => {
    const draft = mail({ message_id: "draft-3@studio-halde.example", in_reply_to: "b@studio-halde.example" });
    expect(threadingHeaders("draft", draft).references).toBe("b@studio-halde.example");
  });

  it("sends a fresh message without threading", () => {
    expect(threadingHeaders("new", null)).toEqual({ in_reply_to: undefined, references: undefined });
  });
});
