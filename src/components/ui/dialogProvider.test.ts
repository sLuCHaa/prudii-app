import { describe, it, expect, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot } from "react-dom/client";
import "../../lib/i18n";
import { DialogProvider, useDialog } from "./DialogProvider";

let dialog: ReturnType<typeof useDialog>;
let unmount = () => {};

function Probe() {
  dialog = useDialog();
  return null;
}

function render() {
  const root = createRoot(document.body.appendChild(document.createElement("div")));
  act(() => root.render(createElement(DialogProvider, null, createElement(Probe))));
  unmount = () => act(() => root.unmount());
}

afterEach(() => {
  unmount();
  document.body.innerHTML = "";
});

const question = { title: "Titel", message: "Frage?" };
const settle = () => act(async () => { await new Promise((r) => setTimeout(r)); });

describe("a replaced dialog", () => {
  it.each(["confirm", "danger", "alert"] as const)("resolves a %s dialog as cancelled", async (type) => {
    render();
    const done = vi.fn();
    act(() => { void dialog[type](question).then(done); });
    act(() => { void dialog.alert(question); });
    await settle();
    expect(done).toHaveBeenCalledWith(type === "alert" ? undefined : false);
  });

  it("is resolved even when both open in one tick", async () => {
    render();
    const done = vi.fn();
    act(() => {
      void dialog.danger(question).then(done);
      void dialog.confirm(question);
    });
    await settle();
    expect(done).toHaveBeenCalledWith(false);
  });

  it("takes its own value where cancelling would destroy something", async () => {
    render();
    const done = vi.fn();
    act(() => { void dialog.confirm({ ...question, replacedValue: true }).then(done); });
    act(() => { void dialog.alert(question); });
    await settle();
    expect(done).toHaveBeenCalledWith(true);
  });
});
