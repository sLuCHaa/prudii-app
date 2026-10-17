import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Button, IconButton } from "./Button";

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

describe("Button", () => {
  it("gives filled buttons the tactile look on control corners", () => {
    const h = html(createElement(Button, { variant: "primary" }, "X"));
    expect(h).toContain("tactile-filled");
    expect(h).toContain("rounded-control");
    expect(h).not.toContain("rounded-full");
  });

  it("fills each filled variant with its own color", () => {
    expect(html(createElement(Button, { variant: "danger" }, "X"))).toContain("[--tactile-fill:var(--c-danger)]");
    expect(html(createElement(Button, { variant: "signal" }, "X"))).toContain("[--tactile-fill:var(--c-signal)]");
  });

  it("gives secondary buttons the quiet tactile look", () => {
    expect(html(createElement(Button, { variant: "secondary" }, "X"))).toContain("tactile-quiet");
  });

  it("keeps ghost buttons flat", () => {
    expect(html(createElement(Button, { variant: "ghost" }, "X"))).not.toContain("tactile-");
  });

  it("does not move when disabled or not animated", () => {
    expect(html(createElement(Button, { variant: "primary", disabled: true }, "X"))).toContain("tactile-static");
    expect(html(createElement(Button, { variant: "secondary", animated: false }, "X"))).toContain("tactile-static");
  });

  it("shapes icon buttons like buttons", () => {
    const h = html(createElement(IconButton, { icon: createElement("svg"), "aria-label": "x" }));
    expect(h).toContain("rounded-control");
    expect(h).not.toContain("rounded-full");
  });

  it("leaves border and background to the tactile classes", () => {
    expect(html(createElement(Button, { variant: "primary" }, "X"))).not.toContain("border-transparent");
    const h = html(createElement(Button, { variant: "secondary" }, "X"));
    expect(h).not.toContain("border-border");
    expect(h).not.toContain("bg-surface");
  });

  it("styles filled icon buttons like buttons", () => {
    const h = html(createElement(IconButton, { variant: "primary", icon: createElement("svg"), "aria-label": "x" }));
    expect(h).toContain("tactile-filled");
    expect(h).toContain("rounded-control");
    expect(h).not.toContain("border-transparent");
  });

  it("presses tactile buttons without a transition delay", () => {
    for (const variant of ["primary", "danger", "success", "signal", "secondary"] as const) {
      expect(html(createElement(Button, { variant }, "X"))).toContain("active:duration-0");
    }
    expect(html(createElement(IconButton, { variant: "secondary", icon: createElement("svg"), "aria-label": "x" }))).toContain("active:duration-0");
  });

  it("does not move while loading", () => {
    expect(html(createElement(Button, { variant: "primary", loading: true }, "X"))).toContain("tactile-static");
  });
});
