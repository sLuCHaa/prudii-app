import { describe, it, expect } from "vitest";
import { splitMailSource, foldedBytes, MIN_RUN_LINES } from "./mailSource";

const B64 = "A".repeat(76);

function payload(lines: number, tail?: string): string {
  const body = Array.from({ length: lines }, () => B64);
  if (tail !== undefined) body.push(tail);
  return body.join("\n");
}

describe("splitMailSource", () => {
  it("leaves a message without payloads alone", () => {
    const src = "From: a@b.de\nSubject: Hallo\n\nGuten Morgen\n";
    const segs = splitMailSource(src);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("text");
    expect(segs[0].text).toContain("Guten Morgen");
  });

  it("folds a wrapped payload and keeps the headers around it", () => {
    const src = [
      "Content-Type: application/pdf",
      "Content-Transfer-Encoding: base64",
      "",
      payload(20, "AAAA=="),
      "",
      "--boundary--",
    ].join("\n");
    const segs = splitMailSource(src);
    expect(segs.map((s) => s.kind)).toEqual(["text", "base64", "text"]);
    expect(segs[0].text).toContain("Content-Transfer-Encoding: base64");
    expect(segs[1].lines).toBe(21); // 20 full lines plus the padded tail
    expect(segs[2].text).toContain("--boundary--");
  });

  it("keeps short runs visible — a long header value is not a payload", () => {
    const src = ["DKIM-Signature: v=1;", payload(MIN_RUN_LINES - 1), "To: a@b.de"].join("\n");
    const segs = splitMailSource(src);
    expect(segs).toHaveLength(1);
    expect(segs[0].kind).toBe("text");
  });

  it("folds at exactly the threshold", () => {
    const segs = splitMailSource(payload(MIN_RUN_LINES));
    expect(segs.map((s) => s.kind)).toEqual(["base64"]);
  });

  it("folds several payloads independently", () => {
    const src = [payload(10), "--b", payload(12), "--b--"].join("\n");
    const segs = splitMailSource(src);
    expect(segs.map((s) => s.kind)).toEqual(["base64", "text", "base64", "text"]);
    expect(segs[0].lines).toBe(10);
    expect(segs[2].lines).toBe(12);
  });

  it("estimates the decoded size from the payload characters", () => {
    // 10 lines of 76 chars, no padding: 760 * 3/4
    const segs = splitMailSource(payload(10));
    expect(segs[0].bytes).toBe(570);
    expect(foldedBytes(segs)).toBe(570);
  });

  it("subtracts padding from the estimate", () => {
    const withPad = splitMailSource(payload(10, "AA=="));
    const withoutPad = splitMailSource(payload(10, "AAAA"));
    expect(withPad[0].bytes).toBeLessThan(withoutPad[0].bytes);
  });

  it("handles CRLF line endings, which is what servers actually send", () => {
    const src = ["Subject: x", "", payload(10)].join("\r\n");
    const segs = splitMailSource(src);
    expect(segs.map((s) => s.kind)).toEqual(["text", "base64"]);
    expect(segs[0].text).not.toContain("\r");
  });

  it("returns nothing for an empty source", () => {
    expect(splitMailSource("")).toEqual([]);
  });

  it("reports no folded bytes when there is no payload", () => {
    expect(foldedBytes(splitMailSource("From: a@b.de"))).toBe(0);
  });
});
