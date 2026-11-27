import { describe, it, expect, beforeAll } from "vitest";
import i18n from "./i18n";
import de from "../locales/de.json";
import ru from "../locales/ru.json";
import { PROVIDER_PRESETS } from "./providers";
import {
  DEFAULT_POP3_RULE,
  accountSetupError,
  clampDeleteDays,
  defaultPop3Port,
  describePop3Rule,
  ruleFromAccount,
  ruleToSettings,
  supportsPop3,
  switchPop3Port,
} from "./pop3";

beforeAll(() => {
  i18n.addResourceBundle("de", "translation", de, true, true);
  i18n.addResourceBundle("ru", "translation", ru, true, true);
});

const preset = (id: string) => PROVIDER_PRESETS.find((p) => p.id === id)!;
const german = async () => {
  await i18n.changeLanguage("de");
  return i18n.t;
};

describe("describePop3Rule", () => {
  it("words the default rule", async () => {
    const t = await german();
    expect(describePop3Rule(t, DEFAULT_POP3_RULE)).toBe(
      "Mails werden 14 Tage nach dem Abruf vom Server gelöscht. Endgültig gelöschte Mails werden sofort auch auf dem Server gelöscht.",
    );
  });

  it("uses the singular for one day", async () => {
    const t = await german();
    expect(describePop3Rule(t, { ...DEFAULT_POP3_RULE, days: 1 })).toContain("Mails werden 1 Tag nach dem Abruf");
  });

  it("words keep and after_fetch", async () => {
    const t = await german();
    expect(describePop3Rule(t, { ...DEFAULT_POP3_RULE, mode: "keep" })).toContain("Mails bleiben nach dem Abruf auf dem Server.");
    expect(describePop3Rule(t, { ...DEFAULT_POP3_RULE, mode: "after_fetch" })).toContain(
      "Mails werden direkt nach dem Abruf vom Server gelöscht.",
    );
  });

  it("says when local deletion stays local", async () => {
    const t = await german();
    expect(describePop3Rule(t, { ...DEFAULT_POP3_RULE, withLocal: false })).toContain(
      "Endgültiges Löschen hier löst keine Löschung auf dem Server aus.",
    );
  });

  it("resolves every Russian plural", async () => {
    await i18n.changeLanguage("ru");
    for (const days of [1, 3, 14]) {
      const text = describePop3Rule(i18n.t, { ...DEFAULT_POP3_RULE, days });
      expect(text).not.toContain("pop3.");
      expect(text).toContain(String(days));
      expect(text).toMatch(/[а-я]/);
    }
  });
});

describe("ports and days", () => {
  it("defaults by encryption", () => {
    expect(defaultPop3Port("ssl")).toBe(995);
    expect(defaultPop3Port("starttls")).toBe(110);
  });

  it("swaps only the standard ports", () => {
    expect(switchPop3Port(995, "starttls")).toBe(110);
    expect(switchPop3Port(110, "ssl")).toBe(995);
    expect(switchPop3Port(1995, "starttls")).toBe(1995);
  });

  it("clamps the days", () => {
    expect(clampDeleteDays(0)).toBe(1);
    expect(clampDeleteDays(999)).toBe(365);
    expect(clampDeleteDays(2.7)).toBe(2);
    expect(clampDeleteDays(NaN)).toBe(14);
  });
});

describe("providers", () => {
  it("offers POP3 only where a server is known", () => {
    for (const id of ["google", "fastmail", "webde", "gmx", "custom"]) expect(supportsPop3(preset(id))).toBe(true);
    for (const id of ["microsoft", "apple", "protonmail"]) expect(supportsPop3(preset(id))).toBe(false);
  });

  it("knows the POP3 servers", () => {
    const rows = ["google", "fastmail", "webde", "gmx"].map((id) => {
      const p = preset(id);
      return [p.pop3Host, p.pop3Port, p.pop3EnableUrl];
    });
    expect(rows).toEqual([
      ["pop.gmail.com", 995, "https://support.google.com/mail/answer/7104828"],
      ["pop.fastmail.com", 995, undefined],
      ["pop3.web.de", 995, "https://hilfe.web.de/pop-imap/einschalten.html"],
      ["pop.gmx.net", 995, "https://hilfe.gmx.net/pop-imap/einschalten.html"],
    ]);
    expect(preset("fastmail").appPasswordUrl).toBe("https://www.fastmail.help/hc/en-us/articles/360058752854");
  });
});

describe("account rule mapping", () => {
  it("round trips and clamps", () => {
    const settings = {
      incoming_protocol: "pop3" as const,
      incoming_security: "ssl" as const,
      pop3_delete_mode: "after_fetch" as const,
      pop3_delete_after_days: 30,
      pop3_delete_with_local: false,
    };
    const rule = ruleFromAccount(settings);
    expect(rule).toEqual({ mode: "after_fetch", days: 30, withLocal: false });
    expect(ruleToSettings(rule)).toEqual({
      pop3_delete_mode: "after_fetch",
      pop3_delete_after_days: 30,
      pop3_delete_with_local: false,
    });
    expect(ruleToSettings({ ...rule, days: 999 }).pop3_delete_after_days).toBe(365);
  });
});

describe("accountSetupError", () => {
  const email = "anna@studio-halde.example";
  const conflict = (provider: string) => `EMAIL_PROVIDER_CONFLICT|${email}|${provider}|password`;

  it("names the existing protocol when it differs", async () => {
    const t = await german();
    const accounts = [{ email: "Anna@Studio-Halde.example", incoming_protocol: "imap" as const }];
    const text = accountSetupError(t, conflict("custom"), "pop3", accounts);
    expect(text).toBe(t("pop3.error.protocolConflict", { email, protocol: "IMAP" }));
    expect(text).toContain("IMAP-Konto");
  });

  it("keeps the provider conflict for the same protocol", async () => {
    const t = await german();
    const accounts = [{ email, incoming_protocol: "imap" as const }];
    for (const [provider, label] of [["google", "Google"], ["microsoft", "Microsoft"], ["webde", "WEBDE"]]) {
      expect(accountSetupError(t, conflict(provider), "imap", accounts)).toBe(
        t("wizard.emailConflict", { email, existingProvider: label }),
      );
    }
  });

  it("explains an existing POP3 account", async () => {
    const t = await german();
    const text = accountSetupError(t, `POP3_ACCOUNT_EXISTS|${email}`, "pop3", []);
    expect(text).toBe(t("pop3.error.accountExists", { email }));
    expect(text).toContain(email);
  });

  it("explains a protocol change", async () => {
    const t = await german();
    expect(accountSetupError(t, "PROTOCOL_CHANGE_UNSUPPORTED", "pop3", [])).toBe(
      "Das Protokoll eines Kontos lässt sich nicht ändern.",
    );
  });

  it("passes other errors through", async () => {
    const t = await german();
    expect(accountSetupError(t, "weird failure", "pop3", [])).toBe("weird failure");
  });
});
