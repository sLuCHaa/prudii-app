import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import type { SieveSupport, VacationState } from "../../types";

vi.mock("../../lib/tauri", () => ({
  checkSieveSupport: vi.fn(),
  getVacation: vi.fn(),
  setVacation: vi.fn(),
}));

import { checkSieveSupport, getVacation, setVacation } from "../../lib/tauri";
import { VacationSection } from "./VacationSection";

const support = vi.mocked(checkSieveSupport);
const read = vi.mocked(getVacation);
const write = vi.mocked(setVacation);

const NONE: VacationState = { enabled: false, from: null, until: null, subject: null, text: "", source: "none", had_addresses: false };

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useAppStore.setState({ toasts: [] });
  support.mockReset();
  read.mockReset();
  write.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
  queryClient.clear();
});

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function render(status: SieveSupport, state: VacationState = NONE) {
  support.mockResolvedValue(status);
  read.mockResolvedValue(state);
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client: queryClient }, createElement(VacationSection, { accountId: "acc-1" })),
    );
  });
  await flush();
}

function textarea() {
  return host.querySelector("textarea");
}

function buttonNamed(label: string) {
  return Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === label) as HTMLButtonElement | undefined;
}

describe("VacationSection", () => {
  it("explains when the provider only offers webmail", async () => {
    await render({ status: "unreachable" });
    expect(host.textContent).toContain(i18n.t("settings.account.vacation.unreachable"));
    expect(textarea()).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it("explains when the server lacks the extension", async () => {
    await render({ status: "unsupported", reason: "no vacation" });
    expect(host.textContent).toContain(i18n.t("settings.account.vacation.unsupported"));
    expect(textarea()).toBeNull();
  });

  it("shows the editor switched off and warns only when switching on", async () => {
    await render({ status: "supported" });
    expect(textarea()).not.toBeNull();
    const warning = i18n.t("settings.account.vacation.panelWarning");
    expect(host.textContent).not.toContain(warning);

    act(() => buttonNamed(i18n.t("settings.account.vacation.on"))!.click());
    expect(host.textContent).toContain(warning);
  });

  it("prefills a notice taken over from webmail", async () => {
    await render({ status: "supported" }, { ...NONE, enabled: true, text: "Bin weg", subject: "Weg", source: "foreign", had_addresses: true });
    expect(host.textContent).toContain(i18n.t("settings.account.vacation.foreign"));
    expect(host.textContent).toContain(i18n.t("settings.account.vacation.foreignAddresses"));
    expect(textarea()!.value).toBe("Bin weg");
    expect((host.querySelector("input[type=text]") as HTMLInputElement).value).toBe("Weg");
  });

  it("locks the section when the script is not one Prudii can rewrite", async () => {
    await render({ status: "supported" }, { ...NONE, source: "locked" });
    expect(host.textContent).toContain(i18n.t("settings.account.vacation.locked"));
    expect(textarea()).toBeNull();
  });

  it("saves the edited notice and re-reads it from the server", async () => {
    await render({ status: "supported" });
    write.mockResolvedValue(undefined);
    act(() => buttonNamed(i18n.t("settings.account.vacation.on"))!.click());
    const area = textarea()!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(area, "Bis Montag weg");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    read.mockResolvedValue({ ...NONE, enabled: true, text: "Bis Montag weg", source: "prudii" });
    await act(async () => {
      buttonNamed(i18n.t("settings.account.vacation.save"))!.click();
    });
    await flush();

    expect(write).toHaveBeenCalledWith("acc-1", { enabled: true, from: null, until: null, subject: null, text: "Bis Montag weg" });
    expect(read).toHaveBeenCalledTimes(2);
    expect(useAppStore.getState().toasts.map((t) => t.type)).toEqual(["success"]);
    // The warning is about switching on; once the server confirms it is on, it goes.
    expect(host.textContent).not.toContain(i18n.t("settings.account.vacation.panelWarning"));
  });

  it("reports a server refusal as an error toast", async () => {
    await render({ status: "supported" });
    write.mockRejectedValue("Server refused: line 3: syntax error");
    act(() => buttonNamed(i18n.t("settings.account.vacation.on"))!.click());
    const area = textarea()!;
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    act(() => {
      setter.call(area, "x");
      area.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      buttonNamed(i18n.t("settings.account.vacation.save"))!.click();
    });
    await flush();

    const toasts = useAppStore.getState().toasts;
    expect(toasts.map((t) => t.type)).toEqual(["error"]);
    expect(toasts[0].message).toContain("syntax error");
    expect(read).toHaveBeenCalledTimes(1);
  });
});
