import { describe, expect, it } from "vitest";

const raw = import.meta.glob("../components/**/*.tsx", {
  query: "?raw",
  import: "default",
  eager: true,
}) as Record<string, string>;

const files = Object.entries(raw).map(([path, text]) => ({ file: path.replace("../components/", ""), text }));

describe("loading indicators", () => {
  it("uses no spinner icon", () => {
    expect(files.filter((f) => /\bLoader2\b/.test(f.text)).map((f) => f.file)).toEqual([]);
  });

  it("uses no spin or pulse utility", () => {
    expect(files.filter((f) => f.text.includes("animate-spin")).map((f) => f.file)).toEqual([]);
    expect(files.filter((f) => f.text.includes("animate-pulse")).map((f) => f.file)).toEqual(["ai/AiSummary.tsx"]);
  });
});
