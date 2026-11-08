import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateMailListQueries, MAIL_LIST_QUERY_KEYS, patchCachedMails } from "./mailQueries";
import type { Mail, SearchResult } from "../types";

function record(): { seen: string[]; client: QueryClient } {
  const seen: string[] = [];
  const client = {
    invalidateQueries: ({ queryKey }: { queryKey: readonly unknown[] }) => {
      seen.push(String(queryKey[0]));
    },
  } as unknown as QueryClient;
  return { seen, client };
}

describe("invalidateMailListQueries", () => {
  it("refetches the lists, not just the folder counts", () => {
    // The reading pane's delete used to invalidate "folders" alone. The row
    // swept out, and the moment the sweep cleared pendingRemoveIds the list
    // re-synced from query data that still held the mail — so it came back.
    const { seen, client } = record();
    invalidateMailListQueries(client);
    expect(seen).toContain("mails");
    expect(seen).toContain("filtered-mails");
  });

  it("refreshes the category views and counters, not the removed split inbox", () => {
    const { seen, client } = record();
    invalidateMailListQueries(client);
    expect(seen).toContain("category-mails");
    expect(seen).toContain("category-counts");
    expect(seen).not.toContain("split-inbox-mails");
  });

  it("covers every list a mail can leave", () => {
    const { seen, client } = record();
    invalidateMailListQueries(client);
    expect(seen).toEqual([...MAIL_LIST_QUERY_KEYS]);
  });
});

const hit = (mail_id: string, from_name: string): SearchResult => ({
  mail_id, subject: "Rechnung März", snippet: "", from_name, from_email: "post@studio-halde.example",
  date: "2026-03-12T09:14:00Z", folder_id: "f1", folder_name: "Inbox", is_read: false, has_attachments: false, rank: 1,
});

describe("patchCachedMails", () => {
  it("marks the opened result read in local and server results", () => {
    const qc = new QueryClient();
    qc.setQueryData(["search", "rechnung", undefined], [hit("m1", "Studio Halde"), hit("m2", "Anna Weber")]);
    qc.setQueryData(["search-server", "rechnung", undefined], [hit("m1", "Studio Halde"), hit("m2", "Anna Weber")]);
    patchCachedMails(qc, ["m1"], { is_read: true });
    for (const key of [["search", "rechnung", undefined], ["search-server", "rechnung", undefined]]) {
      const rows = qc.getQueryData<SearchResult[]>(key)!;
      expect(rows.find((r) => r.mail_id === "m1")!.is_read).toBe(true);
      expect(rows.find((r) => r.mail_id === "m2")!.is_read).toBe(false);
    }
  });

  it("leaves a search without data alone", () => {
    const qc = new QueryClient();
    qc.setQueryData(["search", "leer", undefined], undefined);
    patchCachedMails(qc, ["m1"], { is_read: true });
    expect(qc.getQueryData(["search", "leer", undefined])).toBeUndefined();
  });
});

const mail = (id: string): Mail => ({ id, is_read: false, is_starred: false, subject: "Entwurf Frühjahrskatalog" }) as unknown as Mail;

describe("patchCachedMails in list caches", () => {
  it("updates every cached list, so another view cannot bring an old state back", () => {
    const qc = new QueryClient();
    const pages = () => ({ pages: [[mail("m1"), mail("m2")]], pageParams: [0] });
    qc.setQueryData(["mails", "f1", undefined, "date"], pages());
    qc.setQueryData(["all-inbox-mails", undefined, "date"], pages());
    patchCachedMails(qc, ["m1"], { is_read: true, is_starred: true });
    for (const key of [["mails", "f1", undefined, "date"], ["all-inbox-mails", undefined, "date"]]) {
      const [first, second] = qc.getQueryData<{ pages: Mail[][] }>(key)!.pages[0];
      expect([first.is_read, first.is_starred]).toEqual([true, true]);
      expect([second.is_read, second.is_starred]).toEqual([false, false]);
    }
  });

  it("leaves search results' missing star field alone", () => {
    const qc = new QueryClient();
    qc.setQueryData(["search", "rechnung", undefined], [hit("m1", "Studio Halde")]);
    patchCachedMails(qc, ["m1"], { is_starred: true });
    expect(qc.getQueryData<SearchResult[]>(["search", "rechnung", undefined])![0]).toEqual(hit("m1", "Studio Halde"));
  });
});
