import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { createElement, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import i18n from "../../lib/i18n";
import de from "../../locales/de.json";

const { createAccountMock, syncMock } = vi.hoisted(() => ({
  createAccountMock: vi.fn(),
  syncMock: vi.fn(),
}));

vi.mock("../../lib/tauri", () => ({
  testImapConnection: vi.fn(),
  testPop3Connection: vi.fn(),
  startOAuth: vi.fn(),
}));
vi.mock("../../hooks/useAccounts", () => ({
  useCreateAccount: () => ({ mutateAsync: createAccountMock, isPending: false }),
}));
vi.mock("../../hooks/useSync", () => ({ useSyncAccount: () => ({ mutate: syncMock }) }));
vi.mock("../../hooks/useAppConfig", () => ({ useAppConfig: () => ({ data: undefined }) }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));
vi.mock("@tauri-apps/plugin-opener", () => ({ openUrl: vi.fn() }));

import { openUrl } from "@tauri-apps/plugin-opener";
import { testImapConnection, testPop3Connection, startOAuth } from "../../lib/tauri";
import { PROVIDER_PRESETS } from "../../lib/providers";
import type { Pop3Rule } from "../../lib/pop3";
import { AccountWizard } from "./AccountWizard";
import { Pop3DeleteRule } from "./Pop3DeleteRule";
import { WizardStepDone } from "./WizardStepDone";

const testImap = vi.mocked(testImapConnection);
const testPop3 = vi.mocked(testPop3Connection);

const EMAIL = "anna@studio-halde.example";
const DEFAULT_SENTENCE =
  "Mails werden 14 Tage nach dem Abruf vom Server gelöscht. Endgültig gelöschte Mails werden sofort auch auf dem Server gelöscht.";

let root: Root;
let host: HTMLDivElement;

beforeAll(async () => {
  i18n.addResourceBundle("de", "translation", de, true, true);
  await i18n.changeLanguage("de");
});

beforeEach(() => {
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  vi.clearAllMocks();
  testImap.mockResolvedValue(undefined as never);
  testPop3.mockResolvedValue({ message_count: 3, supports_uidl: true });
  createAccountMock.mockResolvedValue({ id: "acc-1" });
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

async function flush() {
  for (let i = 0; i < 4; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
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

function blur(input: HTMLInputElement) {
  act(() => {
    input.focus();
    input.blur();
  });
}

function findButton(label: string) {
  return Array.from(host.querySelectorAll("button")).find((b) => b.textContent?.trim() === label);
}

function button(label: string) {
  const found = findButton(label);
  if (!found) throw new Error(`no button "${label}"`);
  return found;
}

function field(label: string) {
  const node = Array.from(host.querySelectorAll("label")).find((l) => l.textContent?.trim() === label);
  if (!node) throw new Error(`no label "${label}"`);
  const input = node.control ?? node.parentElement!.querySelector("input");
  return input as HTMLInputElement;
}

const input = (selector: string) => host.querySelector(selector) as HTMLInputElement;
const toggle = () => host.querySelector('[role="group"][aria-label="Abrufprotokoll"]');

function open(id: string) {
  const preset = PROVIDER_PRESETS.find((p) => p.id === id)!;
  act(() => root.render(createElement(AccountWizard)));
  const name = Array.from(host.querySelectorAll("div")).find(
    (d) => d.children.length === 0 && d.textContent === preset.name,
  )!;
  click(name);
}

function choosePop3() {
  click(button("POP3"));
}

describe("account wizard protocol choice", () => {
  it.each(["google", "fastmail", "webde", "gmx", "custom"])("offers POP3 for %s", (id) => {
    open(id);
    expect(toggle()).not.toBeNull();
    expect(button("IMAP").getAttribute("aria-pressed")).toBe("true");
  });

  it.each(["microsoft", "apple", "protonmail"])("offers no protocol choice for %s", (id) => {
    open(id);
    expect(toggle()).toBeNull();
    expect(host.textContent).not.toContain(i18n.t("pop3.ruleTitle"));
  });

  it("swaps the Google sign-in for a password login with POP3", () => {
    open("google");
    const signIn = i18n.t("wizard.signInWith", { provider: "Google" });
    expect(findButton(signIn)).toBeDefined();
    expect(input("input[type=password]")).toBeNull();

    choosePop3();

    expect(findButton(signIn)).toBeUndefined();
    expect(input("input[type=password]")).not.toBeNull();
    expect(host.textContent).toContain(i18n.t("pop3.appPasswordGmail"));
    expect(host.textContent).not.toContain(i18n.t("wizard.appPasswordHint"));
    expect(findButton(i18n.t("wizard.createAppPassword"))).toBeDefined();
    click(button(i18n.t("pop3.enableLink")));
    expect(openUrl).toHaveBeenCalledWith("https://support.google.com/mail/answer/7104828");
    expect(startOAuth).not.toHaveBeenCalled();
  });

  it("words the app password hint for Fastmail", () => {
    open("fastmail");
    expect(host.textContent).toContain(i18n.t("wizard.appPasswordHint"));
    choosePop3();
    expect(host.textContent).toContain(i18n.t("pop3.appPasswordFastmail"));
    expect(findButton(i18n.t("pop3.enableLink"))).toBeUndefined();
  });

  it.each(["webde", "gmx"])("asks to switch POP3 on for %s", (id) => {
    const preset = PROVIDER_PRESETS.find((p) => p.id === id)!;
    open(id);
    const hint = i18n.t("pop3.enableHint", { provider: preset.name });
    expect(host.textContent).not.toContain(hint);
    choosePop3();
    expect(host.textContent).toContain(hint);
    expect(host.textContent).toContain(i18n.t("wizard.appPasswordHint"));
    click(button(i18n.t("pop3.enableLink")));
    expect(openUrl).toHaveBeenCalledWith(preset.pop3EnableUrl);
  });
});

describe("account wizard delete rule", () => {
  it("shows the default rule at once and follows every change", () => {
    open("webde");
    expect(host.textContent).not.toContain(DEFAULT_SENTENCE);
    choosePop3();
    expect(host.textContent).toContain(DEFAULT_SENTENCE);
    expect(host.querySelector("details")).toBeNull();
    expect(host.textContent).toContain(i18n.t("pop3.rule.localOnly"));

    type(field(i18n.t("pop3.days")), "30");
    expect(host.textContent).toContain("Mails werden 30 Tage nach dem Abruf vom Server gelöscht.");

    click(button(i18n.t("pop3.mode.keep")));
    expect(button(i18n.t("pop3.mode.keep")).getAttribute("aria-pressed")).toBe("true");
    expect(host.textContent).toContain(i18n.t("pop3.rule.keep"));
    expect(input("input[max='365']")).toBeNull();

    click(host.querySelector('[role="switch"]')!);
    expect(host.textContent).toContain(i18n.t("pop3.rule.withoutLocal"));
    expect(host.textContent).not.toContain(i18n.t("pop3.rule.localOnly"));

    click(button(i18n.t("pop3.mode.afterFetch")));
    expect(host.textContent).toContain(i18n.t("pop3.rule.afterFetch"));
    expect(host.textContent).toContain(i18n.t("pop3.rule.localOnly"));
  });

  it("starts from the defaults again for the next provider", () => {
    open("webde");
    choosePop3();
    click(button(i18n.t("pop3.mode.keep")));
    click(button(i18n.t("common.back")));
    open("gmx");
    expect(button("IMAP").getAttribute("aria-pressed")).toBe("true");
    choosePop3();
    expect(host.textContent).toContain(DEFAULT_SENTENCE);
  });

  it.each([
    ["0", 1],
    ["999", 365],
    ["", 14],
  ])("turns %j days into %i on blur", (typed, expected) => {
    let latest: Pop3Rule = { mode: "after_days", days: 20, withLocal: true };
    const render = () =>
      root.render(
        createElement(Pop3DeleteRule, {
          rule: latest,
          onChange: (rule: Pop3Rule) => {
            latest = rule;
            render();
          },
        }),
      );
    act(render);
    const days = field(i18n.t("pop3.days"));
    expect(days.min).toBe("1");
    expect(days.max).toBe("365");

    type(days, typed);
    expect(days.value).toBe(typed);
    blur(days);

    expect(latest.days).toBe(expected);
    expect(days.value).toBe(String(expected));
  });
});

describe("account wizard POP3 server fields", () => {
  it("swaps the default port with the security and keeps the IMAP fields", () => {
    open("custom");
    type(input('input[placeholder="imap.example.com"]'), "imap.studio-halde.example");
    choosePop3();
    expect(input('input[placeholder="imap.example.com"]')).toBeNull();
    const port = () => field(i18n.t("pop3.host")).closest(".grid")!.querySelector<HTMLInputElement>("input[type=number]")!;
    expect(port().value).toBe("995");

    click(button("STARTTLS (Port 110)"));
    expect(port().value).toBe("110");
    click(button("SSL/TLS (Port 995)"));
    expect(port().value).toBe("995");

    type(port(), "2995");
    click(button("STARTTLS (Port 110)"));
    expect(port().value).toBe("2995");

    click(button("IMAP"));
    expect(input('input[placeholder="imap.example.com"]').value).toBe("imap.studio-halde.example");
  });
});

describe("account wizard submit", () => {
  async function connect(password: string) {
    type(input("input[type=email]"), EMAIL);
    type(input("input[type=password]"), password);
    click(button(i18n.t("common.connect")));
    await flush();
  }

  function fillCustomServers(incomingPlaceholder: string, incomingHost: string) {
    type(input(`input[placeholder="${incomingPlaceholder}"]`), incomingHost);
    type(input('input[placeholder="smtp.example.com"]'), "smtp.studio-halde.example");
  }

  it("tests POP3 and creates the account with the default rule", async () => {
    const password = crypto.randomUUID();
    open("custom");
    choosePop3();
    fillCustomServers("pop.example.com", "pop.studio-halde.example");
    click(button("STARTTLS (Port 110)"));
    await connect(password);

    expect(testPop3).toHaveBeenCalledWith("pop.studio-halde.example", 110, "starttls", EMAIL, password);
    expect(testImap).not.toHaveBeenCalled();
    expect(createAccountMock).toHaveBeenCalledWith({
      email: EMAIL,
      display_name: "anna",
      provider: "custom",
      color: "#3b82f6",
      imap_host: "pop.studio-halde.example",
      imap_port: 110,
      smtp_host: "smtp.studio-halde.example",
      smtp_port: 465,
      smtp_security: "ssl",
      password,
      auth_type: "password",
      incoming_protocol: "pop3",
      incoming_security: "starttls",
      pop3_delete_mode: "after_days",
      pop3_delete_after_days: 14,
      pop3_delete_with_local: true,
    });
    expect(syncMock).toHaveBeenCalledWith({ accountId: "acc-1", password });
  });

  it("uses the preset POP3 server for a Google account", async () => {
    const password = crypto.randomUUID();
    open("google");
    choosePop3();
    await connect(password);

    expect(testPop3).toHaveBeenCalledWith("pop.gmail.com", 995, "ssl", EMAIL, password);
    expect(createAccountMock.mock.calls[0][0]).toMatchObject({ auth_type: "password", incoming_protocol: "pop3" });
    expect(startOAuth).not.toHaveBeenCalled();
  });

  it("says that the POP3 connection is being tested", async () => {
    testPop3.mockReturnValue(new Promise(() => {}));
    open("webde");
    choosePop3();
    await connect(crypto.randomUUID());
    expect(host.textContent).toContain(i18n.t("pop3.testing"));
  });

  it("explains a server without UIDL and creates nothing", async () => {
    testPop3.mockRejectedValue("POP3_NO_UIDL");
    open("webde");
    choosePop3();
    await connect(crypto.randomUUID());

    expect(host.textContent).toContain(i18n.t("pop3.error.noUidl.title"));
    expect(createAccountMock).not.toHaveBeenCalled();
  });

  it("explains an address that already has a POP3 account", async () => {
    createAccountMock.mockRejectedValue(`POP3_ACCOUNT_EXISTS|${EMAIL}`);
    open("webde");
    choosePop3();
    await connect(crypto.randomUUID());

    expect(host.textContent).toContain(i18n.t("pop3.error.accountExists", { email: EMAIL }));
  });

  it("sends no POP3 fields for an IMAP account", async () => {
    const password = crypto.randomUUID();
    open("custom");
    choosePop3();
    click(button("IMAP"));
    fillCustomServers("imap.example.com", "imap.studio-halde.example");
    await connect(password);

    expect(testImap).toHaveBeenCalledWith("imap.studio-halde.example", 993, EMAIL, password);
    expect(testPop3).not.toHaveBeenCalled();
    expect(Object.keys(createAccountMock.mock.calls[0][0]).sort()).toEqual([
      "auth_type", "color", "display_name", "email", "imap_host", "imap_port",
      "password", "provider", "smtp_host", "smtp_port", "smtp_security",
    ]);
  });
});

describe("account wizard switching after a failed attempt", () => {
  async function failGoogleSignIn() {
    const token = crypto.randomUUID();
    vi.mocked(startOAuth).mockResolvedValue({ email: EMAIL, refresh_token: token } as never);
    createAccountMock.mockRejectedValueOnce("database is locked");
    open("google");
    click(button(i18n.t("wizard.signInWith", { provider: "Google" })));
    await flush();
    expect(host.textContent).toContain("database is locked");
    return token;
  }

  it("never offers the OAuth token as a POP3 password", async () => {
    await failGoogleSignIn();
    choosePop3();
    expect(input("input[type=password]").value).toBe("");
  });

  it("never offers the OAuth token in the password fallback", async () => {
    await failGoogleSignIn();
    click(button(i18n.t("wizard.usePassword")));
    expect(input("input[type=password]").value).toBe("");
  });

  it("drops the old error when the protocol is switched", async () => {
    await failGoogleSignIn();
    choosePop3();
    expect(host.textContent).not.toContain("database is locked");
    click(button("IMAP"));
    expect(host.textContent).not.toContain("database is locked");
  });
});

describe("WizardStepDone folder count", () => {
  const render = (folderCount: number) =>
    act(() =>
      root.render(
        createElement(WizardStepDone, {
          email: EMAIL,
          mailCount: 3,
          folderCount,
          showOnboarding: false,
          onClose: () => {},
        }),
      ),
    );

  it("leaves the folder figure out when there are none", () => {
    render(0);
    expect(host.textContent).toContain(i18n.t("wizard.mails"));
    expect(host.textContent).not.toContain(i18n.t("wizard.folders"));
  });

  it("shows the folder figure otherwise", () => {
    render(5);
    expect(host.textContent).toContain(i18n.t("wizard.folders"));
  });
});
