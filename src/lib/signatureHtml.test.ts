import { describe, it, expect } from "vitest";

describe("test environment", () => {
  it("provides a DOMParser", () => {
    const doc = new DOMParser().parseFromString("<p>hi</p>", "text/html");
    expect(doc.body.textContent).toBe("hi");
  });
});
