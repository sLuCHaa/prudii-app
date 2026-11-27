import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import i18n from "../../lib/i18n";
import { useAppStore } from "../../stores/appStore";
import type { Account } from "../../types";

vi.mock("../../lib/tauri", () => ({
  updateAccountSettings: vi.fn(),
  updateAccountSignature: vi.fn(),
  updateAccountSyncInterval: vi.fn(),
  storeAccountPassword: vi.fn(),
  syncAccount: vi.fn(),
  listSignatures: vi.fn(() => Promise.resolve([])),
  listAccounts: vi.fn(() => Promise.resolve([])),
  checkSieveSupport: vi.fn(() => new Promise(() => {})),
  getVacation: vi.fn(),
  setVacation: vi.fn(),
}));
vi.mock("../ui/DialogProvider", () => ({ useDialog: () => ({ danger: vi.fn() }) }));

import { updateAccountSettings, updateAccountSyncInterval, checkSieveSupport } from "../../lib/tauri";
import { AccountSettings } from "./SettingsPanel";

const update = vi.mocked(updateAccountSettings);

const pop3Account = (overrides: Partial<Account> = {}) =>
  ({
    id: "acc-1",
    email: "anna@studio-halde.example",
    display_name: "Anna Weber",
    provider: "custom",
    color: "#3b82f6",
    imap_host: "pop.studio-halde.example",
    imap_port: 995,
    smtp_host: "smtp.studio-halde.example",
    smtp_port: 465,
    smtp_security: "ssl",
    auth_type: "password",
    load_external_images: "always",
    signature_id: null,
    signature_on_compose: true,
    signature_on_reply: true,
    sync_interval_minutes: 5,
    incoming_protocol: "pop3",
    incoming_security: "ssl",
    pop3_delete_mode: "after_days",
    pop3_delete_after_days: 30,
    pop3_delete_with_local: false,
    ...overrides,
  }) as Account;

const imapAccount = () =>
  pop3Account({ incoming_protocol: "imap", imap_host: "imap.studio-halde.example", imap_port: 993 });

let root: Root;
let host: HTMLDivElement;
let queryClient: QueryClient;

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useAppStore.setState({ toasts: [] });
  vi.clearAllMocks();
  update.mockResolvedValue(undefined as never);
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

async function render(account: Account) {
  act(() => {
    root.render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AccountSettings, {
          account,
          onBack: () => {},
          onEditSignature: () => {},
          dirtyRef: { current: false },
        }),
      ),
    );
  });
  await flush();
}

function button(label: string) {
  const found = Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

function click(el: Element) {
  act(() => {
    (el as HTMLElement).click();
  });
}

function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const labels = () => Array.from(host.querySelectorAll("label")).map((l) => l.textContent?.trim());

function field(label: string) {
  const node = Array.from(host.querySelectorAll("label")).find((l) => l.textContent?.trim() === label);
  if (!node) throw new Error(`no label "${label}"`);
  return node.parentElement!.querySelector("input") as HTMLInputElement;
}

const incomingPort = () =>
  field(i18n.t("pop3.host")).closest(".grid")!.querySelector<HTMLInputElement>("input[type=number]")!;

const sentence = (mode: "keep" | "afterDays", withLocal: boolean) =>
  `${i18n.t(`pop3.rule.${mode}`, { count: 30 })} ${i18n.t(withLocal ? "pop3.rule.withLocal" : "pop3.rule.withoutLocal")}`;

async function save() {
  await act(async () => {
    button(i18n.t("common.saveAll")).click();
  });
  await flush();
}

const baseArgs = (account: Account) => [
  account.id,
  account.display_name,
  account.color,
  account.imap_host,
  account.imap_port,
  account.smtp_host,
  account.smtp_port,
  account.smtp_security,
  "always",
];

describe("account settings for POP3", () => {
  it("shows the stored delete rule, the POP3 server fields and a password field", async () => {
    await render(pop3Account({ provider: "google" }));

    expect(host.textContent).toContain(sentence("afterDays", false));
    expect(host.textContent!.split(i18n.t("pop3.ruleTitle")).length).toBe(2);
    expect(labels()).toContain(i18n.t("pop3.host"));
    expect(labels()).not.toContain(i18n.t("settings.account.imapServer"));
    expect(host.textContent).toContain(i18n.t("pop3.serverSettingsDesc"));
    expect(host.textContent).not.toContain(i18n.t("settings.account.serverSettingsDesc"));
    expect(host.textContent).toContain(`${i18n.t("pop3.protocol")}: POP3`);
    expect(host.querySelector("input[type=password]")).not.toBeNull();
    expect(host.textContent).not.toContain(i18n.t("settings.account.oauthHint"));
  });

  it("places the rule first", async () => {
    await render(pop3Account());
    expect(host.querySelector("h3")!.textContent).toBe(i18n.t("pop3.ruleTitle"));
  });

  it("shows the change hints in the readable warning style", async () => {
    await render(pop3Account());
    click(localSwitch());
    type(days(), "7");
    type(field(i18n.t("pop3.host")), "mail.studio-halde.example");

    const hints = ["pop3.ruleChange.sooner", "pop3.ruleChange.withLocal", "pop3.serverChangeHint"].map((key) =>
      Array.from(host.querySelectorAll("p")).find((p) => p.textContent === i18n.t(key))!,
    );
    for (const hint of hints) expect(hint.classList).toContain("text-warning-fg");
  });

  it("offers no vacation notice", async () => {
    await render(pop3Account());
    expect(checkSieveSupport).not.toHaveBeenCalled();
  });

  it("updates the sentence and saves the new rule without the protocol", async () => {
    const account = pop3Account();
    await render(account);

    click(button(i18n.t("pop3.mode.keep")));
    expect(host.textContent).toContain(sentence("keep", false));
    click(host.querySelector('[aria-labelledby$="-with-local"]')!);
    expect(host.textContent).toContain(sentence("keep", true));
    await save();

    expect(update.mock.calls[0]).toEqual([
      ...baseArgs(account),
      {
        incoming_security: "ssl",
        pop3_delete_mode: "keep",
        pop3_delete_after_days: 30,
        pop3_delete_with_local: true,
      },
    ]);
  });

  it("marks a changed rule as unsaved again", async () => {
    await render(pop3Account());
    await save();
    expect(button(i18n.t("common.saved"))).toBeDefined();
    click(button(i18n.t("pop3.mode.keep")));
    expect(button(i18n.t("common.saveAll"))).toBeDefined();
  });

  it("swaps the default port with the security and saves it", async () => {
    await render(pop3Account());

    click(button("STARTTLS (Port 110)"));
    expect(incomingPort().value).toBe("110");
    click(button("SSL/TLS (Port 995)"));
    expect(incomingPort().value).toBe("995");
    click(button("STARTTLS (Port 110)"));
    await save();

    expect(update.mock.calls[0][4]).toBe(110);
    expect(update.mock.calls[0][9]).toMatchObject({ incoming_security: "starttls" });
  });

  it("falls back to the POP3 port for an emptied port field", async () => {
    await render(pop3Account({ incoming_security: "starttls", imap_port: 2110 }));
    type(incomingPort(), "");
    expect(incomingPort().value).toBe("110");
  });

  it("warns about refetched mail only when the server changes", async () => {
    await render(pop3Account());
    const hint = i18n.t("pop3.serverChangeHint");
    const server = () => field(i18n.t("pop3.host"));
    expect(host.textContent).not.toContain(hint);

    type(server(), " POP.Studio-Halde.example ");
    expect(host.textContent).not.toContain(hint);
    type(server(), "mail.studio-halde.example");
    expect(host.textContent).toContain(hint);
    type(server(), "pop.studio-halde.example");
    expect(host.textContent).not.toContain(hint);
    type(incomingPort(), "2995");
    expect(host.textContent).toContain(hint);
  });

  const sooner = () => i18n.t("pop3.ruleChange.sooner");
  const retroactive = () => i18n.t("pop3.ruleChange.withLocal");
  const days = () => field(i18n.t("pop3.days"));
  const localSwitch = () => host.querySelector('[aria-labelledby$="-with-local"]')!;

  it.each([
    ["keep", "pop3.mode.afterDays"],
    ["keep", "pop3.mode.afterFetch"],
    ["after_days", "pop3.mode.afterFetch"],
  ] as const)("warns that leaving %s for %s reaches fetched mail", async (mode, label) => {
    await render(pop3Account({ pop3_delete_mode: mode }));
    expect(host.textContent).not.toContain(sooner());
    click(button(i18n.t(label)));
    expect(host.textContent).toContain(sooner());
  });

  it("warns about a shorter delay only", async () => {
    await render(pop3Account());
    type(days(), "60");
    expect(host.textContent).not.toContain(sooner());
    type(days(), "7");
    expect(host.textContent).toContain(sooner());
    click(button(i18n.t("pop3.mode.keep")));
    expect(host.textContent).not.toContain(sooner());
  });

  it("warns that switching on server deletes is retroactive", async () => {
    await render(pop3Account());
    expect(host.textContent).not.toContain(retroactive());
    click(localSwitch());
    expect(host.textContent).toContain(retroactive());
  });

  it("drops the hints once the change is saved", async () => {
    await render(pop3Account());
    click(localSwitch());
    type(days(), "7");
    type(field(i18n.t("pop3.host")), "mail.studio-halde.example");
    await save();

    expect(host.textContent).not.toContain(sooner());
    expect(host.textContent).not.toContain(retroactive());
    expect(host.textContent).not.toContain(i18n.t("pop3.serverChangeHint"));
  });

  it("keeps the stored delay when the field is emptied", async () => {
    await render(pop3Account());
    type(days(), "");
    expect(host.textContent).not.toContain(sooner());
    click(button(i18n.t("pop3.mode.keep")));
    await save();
    expect(update.mock.calls[0][9]).toMatchObject({ pop3_delete_after_days: 30 });
  });

  it("restores the stored delay when the emptied field loses focus", async () => {
    await render(pop3Account());
    type(days(), "");
    act(() => {
      days().focus();
      days().blur();
    });
    expect(days().value).toBe("30");
  });

  it("keeps the warnings up to date when a later save step fails", async () => {
    const account = pop3Account();
    useAppStore.setState({ accounts: [account] });
    vi.mocked(updateAccountSyncInterval).mockRejectedValueOnce(new Error("offline"));
    await render(account);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    click(localSwitch());
    await save();

    expect(useAppStore.getState().accounts[0].pop3_delete_with_local).toBe(true);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["accounts"] });
  });

  it("explains a refused protocol change", async () => {
    update.mockRejectedValue("PROTOCOL_CHANGE_UNSUPPORTED");
    await render(pop3Account());
    await save();
    expect(useAppStore.getState().toasts.map((t) => t.message)).toEqual([i18n.t("pop3.error.protocolChange")]);
  });
});

describe("account settings for IMAP", () => {
  it("shows no POP3 controls and saves without incoming settings", async () => {
    const account = imapAccount();
    await render(account);

    expect(host.textContent).not.toContain(i18n.t("pop3.ruleTitle"));
    expect(labels()).toContain(i18n.t("settings.account.imapServer"));
    expect(host.textContent).toContain(i18n.t("settings.account.serverSettingsDesc"));
    expect(host.textContent).not.toContain(`${i18n.t("pop3.protocol")}: POP3`);
    expect(host.textContent).not.toContain("STARTTLS (Port 110)");
    expect(checkSieveSupport).toHaveBeenCalled();

    type(field(i18n.t("settings.account.imapServer")), "mail.studio-halde.example");
    expect(host.textContent).not.toContain(i18n.t("pop3.serverChangeHint"));
    await save();

    expect(update.mock.calls[0]).toEqual(baseArgs({ ...account, imap_host: "mail.studio-halde.example" }));
  });
});
