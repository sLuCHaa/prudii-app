import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MAIL_LINK_BRIDGE, MAIL_LINK_BRIDGE_CSP_HASH, relayBridgeKey, parseBridgeContextMenu } from "./mailLinkBridge";

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
  it("re-dispatches a bridged key on the document and window and reports it", () => {
    const seenWindow: string[] = [];
    const seenDocument: string[] = [];
    const onWindowKey = (e: KeyboardEvent) => seenWindow.push(`${e.ctrlKey ? "ctrl+" : ""}${e.key}`);
    const onDocumentKey = (e: KeyboardEvent) => seenDocument.push(`${e.ctrlKey ? "ctrl+" : ""}${e.key}`);
    window.addEventListener("keydown", onWindowKey);
    document.addEventListener("keydown", onDocumentKey);
    const handled = relayBridgeKey({ __prudiiKey: { key: "r", ctrlKey: true, metaKey: false, shiftKey: false, altKey: false } });
    window.removeEventListener("keydown", onWindowKey);
    document.removeEventListener("keydown", onDocumentKey);
    expect(handled).toBe(true);
    expect(seenWindow).toEqual(["ctrl+r"]);
    expect(seenDocument).toEqual(["ctrl+r"]);
  });

  it("ignores other bridge messages", () => {
    expect(relayBridgeKey({ __prudiiLink: "https://x" })).toBe(false);
    expect(relayBridgeKey(null)).toBe(false);
  });
});

describe("parseBridgeContextMenu", () => {
  it("accepts a context menu payload and rejects anything else", () => {
    expect(parseBridgeContextMenu({ __prudiiContextMenu: { x: 5, y: 6, href: "https://a" } })).toEqual({ x: 5, y: 6, href: "https://a" });
    expect(parseBridgeContextMenu({ __prudiiContextMenu: { x: "5", y: 6 } })).toBeNull();
    expect(parseBridgeContextMenu({ __prudiiLink: "x" })).toBeNull();
  });
});

describe("MAIL_LINK_BRIDGE keydown", () => {
  it("relays plain and modified keys to the parent and still blocks chrome keys", async () => {
    new Function(MAIL_LINK_BRIDGE)();
    const received: Array<{ key: string; ctrlKey: boolean }> = [];
    const onMessage = (e: MessageEvent) => { const p = (e.data as { __prudiiKey?: { key: string; ctrlKey: boolean } })?.__prudiiKey; if (p) received.push(p); };
    window.addEventListener("message", onMessage);

    const j = new KeyboardEvent("keydown", { key: "j", bubbles: true, cancelable: true });
    document.body.dispatchEvent(j);
    const reply = new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true, cancelable: true });
    document.body.dispatchEvent(reply);
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "k", bubbles: true, cancelable: true }));

    await new Promise((r) => setTimeout(r, 0));
    window.removeEventListener("message", onMessage);
    input.remove();

    expect(j.defaultPrevented).toBe(false);
    expect(reply.defaultPrevented).toBe(true);
    expect(received.map((p) => ({ key: p.key, ctrlKey: p.ctrlKey }))).toEqual([
      { key: "j", ctrlKey: false },
      { key: "r", ctrlKey: true },
    ]);
  });
});
