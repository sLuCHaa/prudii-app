import { describe, expect, it } from "vitest";
import { checkState, companyBars, initials, readShare, rowCaption } from "./mailboxCheck";
import type { NewsletterOverview, TrackerReport } from "../types";

const report = (over: Partial<TrackerReport> = {}): TrackerReport => ({
  days: 30,
  scanned_mails: 0,
  mails_with_trackers: 0,
  total: 0,
  other_count: 0,
  by_kind: { pixel: 0, hidden: 0, tracking_domain: 0 },
  companies: [],
  other_domains: [],
  senders: [],
  ...over,
});

const overview = (rows: number): NewsletterOverview => ({
  rows: Array.from({ length: rows }, (_, i) => ({
    account_id: "acc",
    key: `acc|list_id:list${i}.halde-shop.example`,
    name: `Liste ${i}`,
    address: "news@halde-shop.example",
    count: 2,
    read: 1,
    last_received: "2026-10-10T09:00:00Z",
    trackers: 0,
    sample_mail_id: `m${i}`,
    offer: "unsubscribe",
    subscription: null,
  })),
  mails: rows * 2,
  unsubscribed: 0,
  blocked: 0,
});

describe("readShare", () => {
  it("gives the share of read mails", () => {
    expect(readShare({ count: 4, read: 2 })).toBe(0.5);
    expect(readShare({ count: 0, read: 0 })).toBe(0);
  });
});

describe("companyBars", () => {
  it("adds the other trackers as one bar", () => {
    const bars = companyBars(
      report({
        companies: [
          { name: "Mailchimp", known: true, count: 4 },
          { name: "open.halde-shop.example", known: false, count: 1 },
        ],
        other_count: 1,
      }),
    );
    expect(bars).toEqual([
      { label: "Mailchimp", count: 4, other: false },
      { label: "", count: 1, other: true },
    ]);
  });

  it("leaves out the other bar when every tracker has a company", () => {
    expect(companyBars(report({ companies: [{ name: "Klaviyo", known: true, count: 2 }] }))).toEqual([{ label: "Klaviyo", count: 2, other: false }]);
  });
});

describe("rowCaption", () => {
  it("joins the address with the account when several accounts are shown", () => {
    const row = overview(1).rows[0];
    expect(rowCaption(row, null)).toBe("news@halde-shop.example");
    expect(rowCaption(row, "me@studio-halde.example")).toBe("news@halde-shop.example · me@studio-halde.example");
    expect(rowCaption({ ...row, address: "" }, "me@studio-halde.example")).toBe("me@studio-halde.example");
  });
});

describe("initials", () => {
  it("takes the first letters of a name or an address", () => {
    expect(initials("Halde Shop")).toBe("HS");
    expect(initials("news@halde-shop.example")).toBe("N");
    expect(initials("  ")).toBe("?");
    expect(initials("🎉 Halde Shop")).toBe("HS");
    expect(initials("[Studio] Halde")).toBe("SH");
    expect(initials("Ärzte Team")).toBe("ÄT");
  });
});

describe("checkState", () => {
  it("describes an empty check", () => {
    expect(checkState(undefined, undefined, false)).toBe("loading");
    expect(checkState(overview(0), report(), false)).toBe("empty");
    expect(checkState(overview(0), report(), true)).toBe("ready");
    expect(checkState(overview(0), report({ scanned_mails: 3 }), false)).toBe("ready");
    expect(checkState(overview(2), report(), false)).toBe("ready");
    expect(checkState(undefined, undefined, false, true)).toBe("error");
    expect(checkState(overview(2), report(), false, true)).toBe("error");
  });
});
