import { describe, it, expect, vi } from "vitest";

// errorToast pulls in the app store for its toast helper; the store touches
// Tauri APIs at import time, which don't exist under vitest.
vi.mock("../stores/appStore", () => ({
  useAppStore: { getState: () => ({ addToast: () => {} }) },
}));

import { detectCause, causeMessage } from "./errorToast";

describe("detectCause", () => {
  it("classifies network failures", () => {
    expect(detectCause("Connection refused")).toBe("network");
    expect(detectCause("request timeout after 30s")).toBe("network");
    expect(detectCause(new Error("DNS lookup failed"))).toBe("network");
  });

  it("classifies auth failures", () => {
    expect(detectCause("401 Unauthorized")).toBe("auth");
    expect(detectCause("invalid_grant: token expired")).toBe("auth");
    expect(detectCause("403 Forbidden")).toBe("auth");
  });

  it("classifies server failures", () => {
    expect(detectCause("HTTP 503 Service Unavailable")).toBe("server");
    expect(detectCause("internal server error 500")).toBe("server");
  });

  it("returns undefined for unknown errors", () => {
    expect(detectCause("something odd happened")).toBeUndefined();
    expect(detectCause(null)).toBeUndefined();
  });
});

describe("causeMessage", () => {
  it("never returns the raw error or a bare i18n key", () => {
    const msg = causeMessage("ECONNRESET: connection reset by peer");
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("ECONNRESET");
    expect(msg).not.toContain("errors.cause");
  });

  it("falls back to the generic retry line for unknown causes", () => {
    const msg = causeMessage("weird failure");
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).not.toContain("errors.generic");
  });
});
