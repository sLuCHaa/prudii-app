import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createElement, act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import "../../lib/i18n";
import { DialogProvider, useDialog } from "./DialogProvider";
import { WhatsNew } from "./WhatsNew";
import { SEEN_KEY } from "../../lib/whatsNew";

vi.mock("@tauri-apps/api/app", () => ({ getVersion: () => Promise.resolve("1.7.0") }));

let root: Root;
let host: HTMLDivElement;
let resolveConfirm: ((v: boolean) => void) | null = null;

function OpensConfirm() {
  const dialog = useDialog();
  useEffect(() => {
    void dialog.confirm({ title: "Restore drafts?", message: "Two drafts were not sent." }).then((v) => resolveConfirm?.(v));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return null;
}

beforeEach(() => {
  window.matchMedia = ((q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {} })) as unknown as typeof window.matchMedia;
  localStorage.setItem(SEEN_KEY, "1.6.11");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  localStorage.clear();
  resolveConfirm = null;
});

const flush = () => act(async () => { await Promise.resolve(); await Promise.resolve(); });

describe("WhatsNew", () => {
  it("waits until another app dialog is closed", async () => {
    act(() => {
      root.render(createElement(DialogProvider, null, createElement(OpensConfirm), createElement(WhatsNew, { hasAccounts: true })));
    });
    await flush();
    expect(document.getElementById("whats-new-title")).toBeNull();

    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await flush();
    expect(document.getElementById("whats-new-title")).not.toBeNull();
    expect(localStorage.getItem(SEEN_KEY)).toBe("1.6.11");
  });

  it("stays open on Escape and on a click beside it", async () => {
    act(() => {
      root.render(createElement(DialogProvider, null, createElement(WhatsNew, { hasAccounts: true })));
    });
    await flush();
    act(() => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    const backdrop = document.querySelector(".modal-backdrop") as HTMLElement;
    act(() => {
      backdrop.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.getElementById("whats-new-title")).not.toBeNull();
    expect(localStorage.getItem(SEEN_KEY)).toBe("1.6.11");
  });

  it("marks the version as seen when confirmed", async () => {
    act(() => {
      root.render(createElement(DialogProvider, null, createElement(WhatsNew, { hasAccounts: true })));
    });
    await flush();
    const button = document.querySelector('[aria-labelledby="whats-new-title"] button') as HTMLButtonElement;
    act(() => {
      button.click();
    });
    expect(document.getElementById("whats-new-title")).toBeNull();
    expect(localStorage.getItem(SEEN_KEY)).toBe("1.7.0");
  });
});
