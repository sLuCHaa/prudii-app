import { describe, it, expect } from "vitest";
import { QueryClient } from "@tanstack/react-query";
import { invalidateRestoredData } from "./mailQueries";

describe("after a restore", () => {
  it("marks accounts, signatures and mail lists stale", () => {
    const queryClient = new QueryClient();
    for (const key of ["accounts", "signatures", "mails"]) queryClient.setQueryData([key], []);
    invalidateRestoredData(queryClient);
    for (const key of ["accounts", "signatures", "mails"]) {
      expect(queryClient.getQueryState([key])?.isInvalidated, key).toBe(true);
    }
  });
});
