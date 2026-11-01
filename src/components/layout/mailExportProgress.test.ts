(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../../lib/i18n";
import de from "../../locales/de.json";
import { useAppStore } from "../../stores/appStore";
import { MailExportProgress } from "./MailExportProgress";

vi.mock("../../lib/tauri", () => ({ cancelMailExport: vi.fn() }));

let root: Root;
let host: HTMLDivElement;
beforeEach(async () => {
  i18n.addResourceBundle("de", "translation", de, true, true);
  await i18n.changeLanguage("de");
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  act(() => root.unmount());
  host.remove();
  await i18n.changeLanguage("en");
});

function bar() {
  return host.querySelector('[role="progressbar"]');
}

describe("MailExportProgress", () => {
  it("the compact ring carries the counts as its label", async () => {
    useAppStore.setState({ mailExport: { running: true, progress: { processed: 30, total: 120, localCopy: 0, failed: 0 }, result: null } });
    await act(async () => { root.render(createElement(MailExportProgress, { compact: true })); });
    expect(bar()?.getAttribute("aria-valuenow")).toBe("25");
    expect(bar()?.getAttribute("title")).toContain("30/120");
    expect(host.querySelector("button")).toBeNull();
  });

  it("stays at zero before the first progress arrives", async () => {
    useAppStore.setState({ mailExport: { running: true, progress: null, result: null } });
    await act(async () => { root.render(createElement(MailExportProgress)); });
    expect(bar()?.getAttribute("aria-valuenow")).toBe("0");
    expect(host.textContent).toMatch(/0\s%/);
  });
});
