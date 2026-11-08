import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { LightThread, type LightThreadForm, type LightThreadTone } from "./LightThread";

const html = (props: { form: LightThreadForm; tone?: LightThreadTone; on?: boolean; width?: number; inset?: number; label?: string }) =>
  renderToStaticMarkup(createElement(LightThread, props));

describe("LightThread", () => {
  it("marks the decoration hidden without a label", () => {
    const out = html({ form: "area" });
    expect(out).toContain('aria-hidden="true"');
    expect(out).not.toContain("role=");
  });

  it("announces itself with a label", () => {
    const out = html({ form: "area", label: "Laden..." });
    expect(out).toContain('role="status"');
    expect(out).toContain('aria-label="Laden..."');
    expect(out).not.toContain("aria-hidden");
  });

  it("carries form, tone and state", () => {
    const out = html({ form: "edge", tone: "current", on: false });
    expect(out).toContain('data-form="edge"');
    expect(out).toContain('data-tone="current"');
    expect(out).toContain('data-on="false"');
  });

  it("sets width and inset as variables", () => {
    expect(html({ form: "area", width: 140 })).toContain("--thread-w:140px");
    expect(html({ form: "edge", inset: 6 })).toContain("--thread-inset:6px");
  });
});
