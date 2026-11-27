import { describe, expect, it } from "vitest";
import type { Mail } from "../types";
import { dedupListMails } from "./dedupListMails";

function mail(id: string, accountId: string, messageId = "<a@studio-halde.example>"): Mail {
  return {
    id,
    account_id: accountId,
    message_id: messageId,
    subject: "Angebot",
    date: "2026-06-01T10:00:00Z",
    from: { name: "Anna Weber", email: "anna@kunde.example" },
  } as Mail;
}

const ids = (mails: Mail[]) => mails.map((m) => m.id);

describe("dedupListMails", () => {
  it("folds duplicates of other accounts as before", () => {
    expect(ids(dedupListMails([mail("1", "imap"), mail("2", "imap")], new Set()))).toEqual(["1"]);
    expect(ids(dedupListMails([mail("1", "imap"), mail("2", "imap", "<b@studio-halde.example>")], new Set()))).toEqual(["1"]);
  });

  it("keeps both twins of a POP3 account", () => {
    expect(ids(dedupListMails([mail("1", "pop"), mail("2", "pop")], new Set(["pop"])))).toEqual(["1", "2"]);
  });

  it("still folds the same mail seen through a second account", () => {
    expect(ids(dedupListMails([mail("1", "imap"), mail("2", "pop")], new Set(["pop"])))).toEqual(["1"]);
    expect(ids(dedupListMails([mail("1", "pop"), mail("2", "imap")], new Set(["pop"])))).toEqual(["1"]);
  });
});
