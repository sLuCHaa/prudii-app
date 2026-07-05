import i18n from "./i18n";

export interface ImapErrorHint {
  title: string;
  detail: string;
  link?: string;
  linkLabel?: string;
}

export function mapImapError(
  raw: unknown,
  context?: { provider?: string; email?: string },
): ImapErrorHint {
  const msg = String(
    (raw as { message?: string })?.message ?? raw ?? "",
  ).toLowerCase();
  const email = context?.email ?? "";
  const provider =
    context?.provider?.toLowerCase() ?? detectProvider(email) ?? "";

  if (
    /authentic|invalid credentials|login failed|badlogin|password/.test(msg)
  ) {
    if (provider === "gmail" || /gmail|googlemail/.test(email)) {
      return {
        title: i18n.t("imapError.authFailed.title"),
        detail: i18n.t("imapError.authFailed.gmail"),
        link: "https://support.google.com/mail/answer/185833",
        linkLabel: i18n.t("imapError.authFailed.gmailLink"),
      };
    }
    if (
      provider === "outlook" ||
      /outlook|hotmail|live\.com|office365/.test(email)
    ) {
      return {
        title: i18n.t("imapError.authFailed.title"),
        detail: i18n.t("imapError.authFailed.outlook"),
        link: "https://support.microsoft.com/office/use-an-app-password-with-two-step-verification-5896ed9b-4263-e681-128a-a6f2979a7944",
        linkLabel: i18n.t("imapError.authFailed.outlookLink"),
      };
    }
    return {
      title: i18n.t("imapError.authFailed.title"),
      detail: i18n.t("imapError.authFailed.generic"),
    };
  }

  if (/tls|ssl|handshake|certificate/.test(msg)) {
    return {
      title: i18n.t("imapError.tls.title"),
      detail: i18n.t("imapError.tls.detail"),
    };
  }

  if (
    /connection refused|econnrefused|no connection|unable to connect/.test(msg)
  ) {
    return {
      title: i18n.t("imapError.connection.title"),
      detail: i18n.t("imapError.connection.detail"),
    };
  }

  if (/dns|resolve|no such host|getaddrinfo/.test(msg)) {
    return {
      title: i18n.t("imapError.dns.title"),
      detail: i18n.t("imapError.dns.detail"),
    };
  }

  if (/timeout|timed out|connection reset|broken pipe/.test(msg)) {
    return {
      title: i18n.t("imapError.timeout.title"),
      detail: i18n.t("imapError.timeout.detail"),
    };
  }

  return {
    title: i18n.t("imapError.unknown.title"),
    detail: String(
      (raw as { message?: string })?.message ??
        raw ??
        i18n.t("imapError.unknown.detail"),
    ),
  };
}

function detectProvider(email: string): string | null {
  const domain = email.split("@")[1]?.toLowerCase() ?? "";
  if (/gmail\.com|googlemail\.com/.test(domain)) return "gmail";
  if (/outlook\.com|hotmail\.com|live\.com|office365\.com/.test(domain))
    return "outlook";
  if (/icloud\.com|me\.com|mac\.com/.test(domain)) return "icloud";
  if (/fastmail\.com/.test(domain)) return "fastmail";
  return null;
}
