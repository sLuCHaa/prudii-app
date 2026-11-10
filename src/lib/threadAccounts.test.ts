import { describe, it, expect } from "vitest";
import { otherAccount } from "./threadAccounts";
import type { Account } from "../types";

const account = (id: string, email: string) => ({ id, email, display_name: email, color: "#3b82f6" }) as Account;

const ACCOUNTS = [account("a1", "anna@studio-halde.example"), account("a2", "info@studio-halde.example")];

describe("otherAccount", () => {
  it("names no account for a mail from the opened mail's own account", () => {
    expect(otherAccount({ account_id: "a1" }, "a1", ACCOUNTS)).toBeNull();
  });

  it("names the account a card from elsewhere lies in", () => {
    expect(otherAccount({ account_id: "a2" }, "a1", ACCOUNTS)).toBe(ACCOUNTS[1]);
  });

  it("names none when that account no longer exists", () => {
    expect(otherAccount({ account_id: "removed" }, "a1", ACCOUNTS)).toBeNull();
  });
});
