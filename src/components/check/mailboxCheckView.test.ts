import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18next from "i18next";
import "../../lib/i18n";
import { DialogProvider } from "../ui/DialogProvider";
import { useAppStore } from "../../stores/appStore";
import type { NewsletterOverview, TrackerReport } from "../../types";

const api = vi.hoisted(() => ({
  getNewsletterOverview: vi.fn(),
  getTrackerReport: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  getNewsletterOverview: api.getNewsletterOverview,
  getTrackerReport: api.getTrackerReport,
  unsubscribeMail: vi.fn(),
  blockSender: vi.fn(),
  allowListAgain: vi.fn(),
  retryUnsubscribe: vi.fn(),
}));

vi.mock("../../lib/trackerScan", () => ({ runTrackerScan: vi.fn(async () => 0) }));

import { MailboxCheckView } from "./MailboxCheckView";

const OVERVIEW: NewsletterOverview = {
  rows: [
    {
      account_id: "acc",
      key: "acc|list_id:wr.halde-shop.example",
      name: "Wochenrückblick",
      address: "news@halde-shop.example",
      count: 6,
      read: 1,
      last_received: "2026-10-12T09:00:00Z",
      trackers: 4,
      sample_mail_id: "m1",
      offer: "unsubscribe",
      subscription: null,
    },
  ],
  mails: 6,
  unsubscribed: 2,
  blocked: 1,
};

const REPORT: TrackerReport = {
  days: 30,
  scanned_mails: 6,
  mails_with_trackers: 3,
  total: 9,
  other_count: 2,
  by_kind: { pixel: 2, hidden: 0, tracking_domain: 7 },
  companies: [{ name: "Mailchimp", known: true, count: 7 }],
  other_domains: [{ name: "open.halde-shop.example", known: false, count: 2 }],
  senders: [{ name: "Halde Shop", address: "news@halde-shop.example", count: 9, mails: 3 }],
};

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useAppStore.setState({ accounts: [] });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
  vi.clearAllMocks();
});

async function renderView() {
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client: queryClient }, createElement(DialogProvider, null, createElement(MailboxCheckView))));
  });
}

describe("MailboxCheckView", () => {
  it("shows tiles, the newsletter table and the tracker panel", async () => {
    api.getNewsletterOverview.mockResolvedValue(OVERVIEW);
    api.getTrackerReport.mockResolvedValue(REPORT);
    await renderView();
    await vi.waitFor(() => expect(host.querySelector('[role="table"]')).not.toBeNull());
    const rows = host.querySelectorAll('[role="row"][data-row-key]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain("Wochenrückblick");
    expect(host.textContent).toContain("Mailchimp");
    expect(host.textContent).toContain("open.halde-shop.example");
    expect(host.textContent).toContain(i18next.t("unsubscribe.title"));
  });

  it("offers a reload when the check cannot be loaded", async () => {
    api.getNewsletterOverview.mockRejectedValue(new Error("db busy"));
    api.getTrackerReport.mockResolvedValue(REPORT);
    await renderView();
    await vi.waitFor(() => expect(host.textContent).toContain(i18next.t("mailboxCheck.loadFailed")));
    const reload = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === i18next.t("mailboxCheck.reload"));
    expect(reload).toBeDefined();
    api.getNewsletterOverview.mockResolvedValue(OVERVIEW);
    await act(async () => reload!.click());
    await vi.waitFor(() => expect(host.querySelector('[role="table"]')).not.toBeNull());
  });
});
