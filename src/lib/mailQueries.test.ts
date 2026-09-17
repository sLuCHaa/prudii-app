import { describe, it, expect } from "vitest";
import type { QueryClient } from "@tanstack/react-query";
import { invalidateMailListQueries, MAIL_LIST_QUERY_KEYS } from "./mailQueries";

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

  it("covers every list a mail can leave", () => {
    const { seen, client } = record();
    invalidateMailListQueries(client);
    expect(seen).toEqual([...MAIL_LIST_QUERY_KEYS]);
  });
});
