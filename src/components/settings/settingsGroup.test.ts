import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Switch } from "../ui/Switch";
import { SettingsBlock, SettingsGroup, SettingsRow } from "./SettingsGroup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const html = (el: React.ReactElement) => renderToStaticMarkup(el);

let root: Root | null = null;
let container: HTMLElement | null = null;

function mount(el: React.ReactElement) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root!.render(el));
  return container;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("settings group", () => {
  it("renders the section name as a heading above its card", () => {
    const h = html(createElement(SettingsGroup, { title: "Darstellung" }, createElement(SettingsBlock, { description: "Wähle" })));
    expect(h).toMatch(/settings-group-label[^>]*>.*<h3[^>]*>Darstellung<\/h3>/s);
    expect(h).toContain("settings-group-card");
    expect(h).toContain("settings-block-desc");
  });

  it("places icon and action around the heading", () => {
    const h = html(createElement(SettingsGroup, { title: "T", icon: createElement("i", { id: "ic" }), action: createElement("b", { id: "ac" }) }));
    expect(h.indexOf('id="ic"')).toBeLessThan(h.indexOf("<h3"));
    expect(h.indexOf('id="ac"')).toBeGreaterThan(h.indexOf("</h3>"));
  });

  it("makes a row with a control a label", () => {
    expect(html(createElement(SettingsRow, { title: "Ton", control: createElement("span") }))).toMatch(/^<label[^>]*settings-row/);
  });

  it("makes a row without a control a div, clickable on request", () => {
    expect(html(createElement(SettingsRow, { title: "Konto" }))).toMatch(/^<div[^>]*settings-row/);
    expect(html(createElement(SettingsRow, { title: "Konto", onClick: () => {} }))).toContain("data-clickable");
  });

  it("renders a div row that still holds its control when asked", () => {
    const h = html(createElement(SettingsRow, { title: "Version", as: "div", control: createElement("span", { id: "val" }) }));
    expect(h).toMatch(/^<div[^>]*settings-row/);
    expect(h).toContain('id="val"');
    expect(h).not.toContain("data-clickable");
  });

  it("calls onClick of a clickable row", () => {
    const onClick = vi.fn();
    const c = mount(createElement(SettingsRow, { title: "Konto", onClick }));
    act(() => c.querySelector<HTMLElement>(".settings-row")!.click());
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("makes a clickable row reachable and operable by keyboard", () => {
    const onClick = vi.fn();
    const c = mount(createElement(SettingsRow, { title: "Konto", onClick }));
    const row = c.querySelector<HTMLElement>(".settings-row")!;
    expect(row.getAttribute("role")).toBe("button");
    expect(row.tabIndex).toBe(0);
    act(() => { row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    act(() => { row.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true })); });
    expect(onClick).toHaveBeenCalledTimes(2);
  });

  it("ignores keys pressed on a nested control of a clickable row", () => {
    const onClick = vi.fn();
    const c = mount(createElement(SettingsRow, { title: "Konto", onClick, control: undefined, children: createElement("button", { id: "inner" }) }));
    act(() => { c.querySelector("#inner")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(onClick).not.toHaveBeenCalled();
  });

  it("keeps a plain row out of the tab order", () => {
    const h = html(createElement(SettingsRow, { title: "Konto" }));
    expect(h).not.toContain("tabindex");
    expect(h).not.toContain("role=");
  });

  it("toggles the row's switch once when its text is clicked", () => {
    const onChange = vi.fn();
    const c = mount(createElement(SettingsRow, { title: "Ton", control: createElement(Switch, { checked: false, onChange }) }));
    act(() => c.querySelector<HTMLElement>(".settings-row-title")!.click());
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});
