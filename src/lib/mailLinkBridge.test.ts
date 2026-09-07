import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MAIL_LINK_BRIDGE, MAIL_LINK_BRIDGE_CSP_HASH, relayBridgeKey } from "./mailLinkBridge";

describe("MAIL_LINK_BRIDGE CSP hash", () => {
  it("matches the pinned hash constant", () => {
    const hash = "sha256-" + createHash("sha256").update(MAIL_LINK_BRIDGE, "utf8").digest("base64");
    expect(hash).toBe(MAIL_LINK_BRIDGE_CSP_HASH);
  });

  it("is allow-listed in the tauri CSP", () => {
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    const csp: string = conf.app.security.csp;
    expect(csp).toContain(MAIL_LINK_BRIDGE_CSP_HASH);
  });
});

describe("relayBridgeKey", () => {
  it("re-dispatches a bridged key on the window and reports it", () => {
    const seen: string[] = [];
    const onKey = (e: KeyboardEvent) => seen.push(`${e.ctrlKey ? "ctrl+" : ""}${e.key}`);
    window.addEventListener("keydown", onKey);
    const handled = relayBridgeKey({ __prudiiKey: { key: "r", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false } });
    window.removeEventListener("keydown", onKey);
    expect(handled).toBe(true);
    expect(seen).toEqual(["ctrl+r"]);
  });

  it("ignores other bridge messages", () => {
    expect(relayBridgeKey({ __prudiiLink: "https://x" })).toBe(false);
    expect(relayBridgeKey(null)).toBe(false);
  });
});
