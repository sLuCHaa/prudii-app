import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const script = new DOMParser().parseFromString(html, "text/html").querySelector("script:not([src])")?.textContent ?? "";

describe("index.html boot theme script", () => {
  it("is allow-listed by its hash in the tauri CSP", () => {
    const hash = "sha256-" + createHash("sha256").update(script, "utf8").digest("base64");
    const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"));
    expect(conf.app.security.csp).toContain(hash);
  });

  it("marks the stored app theme and leaves system mode to the media query", () => {
    for (const [stored, expected] of [["dark", "dark"], ["light", "light"], ["system", undefined], [null, undefined]] as const) {
      const root = { dataset: {} as Record<string, string> };
      const storage = { getItem: () => stored };
      new Function("localStorage", "document", script)(storage, { documentElement: root });
      expect(root.dataset.boot).toBe(expected);
    }
  });
});
