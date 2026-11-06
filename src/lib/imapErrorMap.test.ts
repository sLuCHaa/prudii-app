import { describe, it, expect, vi } from "vitest";
import en from "../locales/en.json";
import de from "../locales/de.json";
import es from "../locales/es.json";
import fr from "../locales/fr.json";
import pt from "../locales/pt.json";
import ru from "../locales/ru.json";
import zh from "../locales/zh.json";

vi.mock("./i18n", () => ({
  default: {
    t: (key: string, opts?: Record<string, unknown>) =>
      opts ? `${key} ${JSON.stringify(opts)}` : key,
  },
}));

import { mapImapError } from "./imapErrorMap";

const AUTH_FAILED = "Login failed: NO [AUTHENTICATIONFAILED] Authentication failed.";

describe("mapImapError", () => {
  it("shows the server's own reply under a rejected sign-in", () => {
    const hint = mapImapError({ message: AUTH_FAILED }, { email: "a@example.org", provider: "custom" });
    expect(hint.title).toBe("imapError.authFailed.title");
    expect(hint.detail).toBe("imapError.authFailed.generic");
    expect(hint.technical).toBe(
      `imapError.serverReply ${JSON.stringify({ reply: "[AUTHENTICATIONFAILED] Authentication failed." })}`,
    );
  });

  it("points WEB.DE users to the IMAP switch and app passwords", () => {
    const hint = mapImapError({ message: AUTH_FAILED }, { email: "a@web.de", provider: "webde" });
    expect(hint.detail).toBe(`imapError.authFailed.imapAccess ${JSON.stringify({ provider: "WEB.DE" })}`);
    expect(hint.link).toBe("https://hilfe.web.de/pop-imap/einschalten.html");
    expect(hint.linkLabel).toBe("imapError.authFailed.imapAccessLink");
  });

  it("recognises a GMX address entered under the custom provider", () => {
    const hint = mapImapError({ message: AUTH_FAILED }, { email: "a@gmx.de", provider: "custom" });
    expect(hint.detail).toBe(`imapError.authFailed.imapAccess ${JSON.stringify({ provider: "GMX" })}`);
    expect(hint.link).toBe("https://hilfe.gmx.net/pop-imap/einschalten.html");
  });

  it("uses the Gmail hint for the Google preset, also with a custom domain", () => {
    const hint = mapImapError({ message: AUTH_FAILED }, { email: "me@company.com", provider: "google" });
    expect(hint.detail).toBe("imapError.authFailed.gmail");
  });

  it("uses the Outlook hint for the Microsoft preset", () => {
    const hint = mapImapError({ message: AUTH_FAILED }, { email: "me@company.com", provider: "microsoft" });
    expect(hint.detail).toBe("imapError.authFailed.outlook");
  });

  it("tells iCloud users they need an app-specific password", () => {
    const hint = mapImapError({ message: AUTH_FAILED }, { email: "a@icloud.com", provider: "apple" });
    expect(hint.detail).toBe("imapError.authFailed.icloud");
    expect(hint.link).toBe("https://support.apple.com/102654");
  });

  it("keeps the raw text of a non-sign-in failure as details", () => {
    const raw = "TLS handshake failed for mail.example.org:993: invalid peer certificate";
    const hint = mapImapError({ message: raw }, { email: "a@example.org" });
    expect(hint.title).toBe("imapError.tls.title");
    expect(hint.technical).toBe(`imapError.details ${JSON.stringify({ details: raw })}`);
  });

  it("does not repeat an unknown error that is already the detail", () => {
    const hint = mapImapError({ message: "weird failure" });
    expect(hint.detail).toBe("weird failure");
    expect(hint.technical).toBeUndefined();
  });
});

const AUTH_KEYS = ["generic", "imapAccess", "imapAccessLink", "icloud", "icloudLink"];

describe("IMAP error translations", () => {
  for (const [lang, data] of Object.entries({ en, de, es, fr, pt, ru, zh })) {
    it(`${lang} has every sign-in hint and the detail lines`, () => {
      const block = (data as Record<string, unknown>).imapError as Record<string, unknown>;
      const auth = block.authFailed as Record<string, unknown>;
      const missing = [
        ...AUTH_KEYS.filter((k) => typeof auth[k] !== "string" || !(auth[k] as string).trim()),
        ...["serverReply", "details"].filter((k) => typeof block[k] !== "string"),
      ];
      expect(missing).toEqual([]);
      expect(auth.imapAccess as string).toContain("{{provider}}");
      expect(block.serverReply as string).toContain("{{reply}}");
      expect(block.details as string).toContain("{{details}}");
    });
  }
});
