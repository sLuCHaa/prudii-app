import { describe, it, expect } from "vitest";
import { compareVersions, displayVersion, pendingRelease, readSeen, RELEASES, SEEN_KEY, type WhatsNewRelease } from "./whatsNew";

const rel = (version: string): WhatsNewRelease => ({ version, items: [{ icon: "calendar", tone: "blue", key: `whatsNew.v${version.replace(/\./g, "_")}.x` }] });
const list = [rel("1.7.0"), rel("1.8.0"), rel("1.6.0")];

describe("compareVersions", () => {
  it("orders by major, minor and patch and ignores suffixes", () => {
    expect(compareVersions("1.7.0", "1.6.11")).toBeGreaterThan(0);
    expect(compareVersions("1.7.0", "1.10.0")).toBeLessThan(0);
    expect(compareVersions("1.7.0-beta.1", "1.7.0")).toBe(0);
    expect(compareVersions("2.0", "1.99.99")).toBeGreaterThan(0);
  });
});

describe("displayVersion", () => {
  it("keeps major and minor", () => {
    expect(displayVersion("1.7.0")).toBe("1.7");
    expect(displayVersion("1.10.3")).toBe("1.10");
  });
});

describe("readSeen", () => {
  it("reads the stored version and reports unreadable storage", () => {
    expect(readSeen({ getItem: (k) => (k === SEEN_KEY ? "1.6.11" : null) })).toBe("1.6.11");
    expect(readSeen({ getItem: () => null })).toBeNull();
    expect(readSeen(null)).toBeUndefined();
    expect(readSeen({ getItem: () => { throw new Error("denied"); } })).toBeUndefined();
  });
});

describe("pendingRelease", () => {
  it("fresh_install_stores_silently", () => {
    expect(pendingRelease("1.7.0", null, false, list)).toEqual({ release: null, store: "1.7.0" });
  });

  it("shows the newest release up to the current version for existing users without a stored value", () => {
    expect(pendingRelease("1.7.0", null, true, list).release?.version).toBe("1.7.0");
  });

  it("shows only the newest release after skipped versions", () => {
    expect(pendingRelease("1.8.2", "1.6.11", true, list)).toEqual({ release: list[1], store: null });
  });

  it("falls back to the last release with highlights after a patch without its own entry", () => {
    expect(pendingRelease("1.7.1", "1.6.11", true, list).release?.version).toBe("1.7.0");
  });

  it("stores silently when no release in range has highlights", () => {
    expect(pendingRelease("1.7.3", "1.7.0", true, list)).toEqual({ release: null, store: "1.7.3" });
  });

  it("does nothing once seen, on the same version or after a downgrade", () => {
    expect(pendingRelease("1.7.0", "1.7.0", true, list)).toEqual({ release: null, store: null });
    expect(pendingRelease("1.7.0", "1.8.0", true, list)).toEqual({ release: null, store: null });
  });

  it("unreadable_storage_shows_nothing", () => {
    expect(pendingRelease("1.7.0", undefined, true, list)).toEqual({ release: null, store: null });
  });

  it("treats a garbled stored value as never seen", () => {
    expect(pendingRelease("1.7.0", "abc", true, list).release?.version).toBe("1.7.0");
  });
});

describe("RELEASES", () => {
  it("has the 1.7.0 highlights with distinct keys", () => {
    const r = RELEASES.find((x) => x.version === "1.7.0");
    expect(r?.items.map((i) => i.key)).toEqual([
      "whatsNew.v1_7_0.calendar",
      "whatsNew.v1_7_0.subscriptions",
      "whatsNew.v1_7_0.tasks",
    ]);
  });

  it("leads 1.7.1 with the new look and repeats the 1.7.0 highlights", () => {
    const r = RELEASES.find((x) => x.version === "1.7.1");
    expect(r?.items.map((i) => i.key)).toEqual([
      "whatsNew.v1_7_1.look",
      "whatsNew.v1_7_0.calendar",
      "whatsNew.v1_7_0.subscriptions",
      "whatsNew.v1_7_0.tasks",
    ]);
    expect(r?.items[0].icon).toBe("sparkles");
  });
});
