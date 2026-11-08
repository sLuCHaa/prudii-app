import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MailStripe } from "./MailStripe";

let root: Root;
let host: HTMLDivElement;
const render = (unread: boolean, starred: boolean) => act(() => root.render(createElement(MailStripe, { unread, starred })));
const readLayer = () => host.querySelector(".mail-stripe-read")!;
const starLayer = () => host.querySelector(".mail-stripe-star")!;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("MailStripe", () => {
  it("does not animate on mount", () => {
    render(false, true);
    expect(readLayer().hasAttribute("data-anim")).toBe(false);
    expect(starLayer().hasAttribute("data-anim")).toBe(false);
  });

  it("animates a read change", () => {
    render(true, false);
    render(false, false);
    expect(readLayer().getAttribute("data-anim")).toBe("out");
    expect(readLayer().getAttribute("data-unread")).toBe("false");
  });

  it("glows when starred", () => {
    render(false, false);
    render(false, true);
    expect(starLayer().getAttribute("data-anim")).toBe("on");
    expect(starLayer().getAttribute("data-on")).toBe("true");
  });
});
