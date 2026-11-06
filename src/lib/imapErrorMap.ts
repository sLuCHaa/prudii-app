import i18n from "./i18n";

export interface ImapErrorHint {
  title: string;
  detail: string;
  link?: string;
  linkLabel?: string;
  technical?: string;
}

// WEB.DE and GMX switch IMAP off by default and again after a longer pause,
// so a correct password still fails until it is switched back on.
const IMAP_SWITCH: Record<string, { name: string; help: string }> = {
  webde: { name: "WEB.DE", help: "https://hilfe.web.de/pop-imap/einschalten.html" },
  gmx: { name: "GMX", help: "https://hilfe.gmx.net/pop-imap/einschalten.html" },
};

const PROVIDER_ALIASES: Record<string, string> = {
  google: "gmail",
  gmail: "gmail",
  microsoft: "outlook",
  outlook: "outlook",
  apple: "icloud",
  icloud: "icloud",
  webde: "webde",
  gmx: "gmx",
};

export function mapImapError(
  raw: unknown,
  context?: { provider?: string; email?: string },
): ImapErrorHint {
  const original = String(
    (raw as { message?: string })?.message ?? raw ?? "",
  );
  const msg = original.toLowerCase();
  const email = context?.email ?? "";
  const provider =
    PROVIDER_ALIASES[context?.provider?.toLowerCase() ?? ""] ??
    detectProvider(email) ??
    "";
  const details = original
    ? i18n.t("imapError.details", { details: original })
    : undefined;

  if (
    /authentic|invalid credentials|login failed|badlogin|password/.test(msg)
  ) {
    const reply = serverReply(original);
    const technical = reply
      ? i18n.t("imapError.serverReply", { reply })
      : undefined;
    const title = i18n.t("imapError.authFailed.title");

    if (provider === "gmail") {
      return {
        title,
        detail: i18n.t("imapError.authFailed.gmail"),
        link: "https://support.google.com/mail/answer/185833",
        linkLabel: i18n.t("imapError.authFailed.gmailLink"),
        technical,
      };
    }
    if (provider === "outlook") {
      return {
        title,
        detail: i18n.t("imapError.authFailed.outlook"),
        link: "https://support.microsoft.com/office/use-an-app-password-with-two-step-verification-5896ed9b-4263-e681-128a-a6f2979a7944",
        linkLabel: i18n.t("imapError.authFailed.outlookLink"),
        technical,
      };
    }
    if (provider === "icloud") {
      return {
        title,
        detail: i18n.t("imapError.authFailed.icloud"),
        link: "https://support.apple.com/102654",
        linkLabel: i18n.t("imapError.authFailed.icloudLink"),
        technical,
      };
    }
    const imapSwitch = IMAP_SWITCH[provider];
    if (imapSwitch) {
      return {
        title,
        detail: i18n.t("imapError.authFailed.imapAccess", { provider: imapSwitch.name }),
        link: imapSwitch.help,
        linkLabel: i18n.t("imapError.authFailed.imapAccessLink"),
        technical,
      };
    }
    return {
      title,
      detail: i18n.t("imapError.authFailed.generic"),
      technical,
    };
  }

  if (/tls|ssl|handshake|certificate/.test(msg)) {
    return {
      title: i18n.t("imapError.tls.title"),
      detail: i18n.t("imapError.tls.detail"),
      technical: details,
    };
  }

  if (
    /connection refused|econnrefused|no connection|unable to connect/.test(msg)
  ) {
    return {
      title: i18n.t("imapError.connection.title"),
      detail: i18n.t("imapError.connection.detail"),
      technical: details,
    };
  }

  if (/dns|resolve|no such host|getaddrinfo/.test(msg)) {
    return {
      title: i18n.t("imapError.dns.title"),
      detail: i18n.t("imapError.dns.detail"),
      technical: details,
    };
  }

  if (/timeout|timed out|connection reset|broken pipe/.test(msg)) {
    return {
      title: i18n.t("imapError.timeout.title"),
      detail: i18n.t("imapError.timeout.detail"),
      technical: details,
    };
  }

  return {
    title: i18n.t("imapError.unknown.title"),
    detail: original || i18n.t("imapError.unknown.detail"),
  };
}

/** The text after our "Login failed: NO" prefix is the server's own explanation. */
function serverReply(original: string): string {
  const m = original.match(/login failed:\s*(?:(?:no|bad)\s+)?(.+)$/is);
  return (m ? m[1] : original).trim();
}

function detectProvider(email: string): string | null {
  const domain = email.split("@")[1]?.trim().toLowerCase() ?? "";
  if (/gmail\.com|googlemail\.com/.test(domain)) return "gmail";
  if (/outlook\.com|hotmail\.com|live\.com|office365\.com/.test(domain))
    return "outlook";
  if (/icloud\.com|me\.com|mac\.com/.test(domain)) return "icloud";
  if (/fastmail\.com/.test(domain)) return "fastmail";
  if (domain === "web.de") return "webde";
  if (/^gmx\.(de|net|at|ch)$/.test(domain)) return "gmx";
  return null;
}
