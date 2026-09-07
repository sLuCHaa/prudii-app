import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MAIL_LINK_BRIDGE, MAIL_LINK_BRIDGE_CSP_HASH } from "./mailLinkBridge";

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
