import type { AccountProvider, SmtpSecurity } from "../types";

export interface ProviderPreset {
  id: AccountProvider;
  name: string;
  icon: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  color: string;
  authMethod: "oauth" | "password";
  appPasswordUrl?: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: "google",
    name: "Google",
    icon: "Mail",
    imapHost: "imap.gmail.com",
    imapPort: 993,
    smtpHost: "smtp.gmail.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    color: "#ea4335",
    authMethod: "oauth",
    appPasswordUrl: "https://myaccount.google.com/apppasswords",
  },
  {
    id: "microsoft",
    name: "Microsoft",
    icon: "Mail",
    imapHost: "outlook.office365.com",
    imapPort: 993,
    smtpHost: "smtp.office365.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    color: "#0078d4",
    authMethod: "oauth",
    appPasswordUrl: "https://account.live.com/proofs/AppPassword",
  },
  {
    id: "apple",
    name: "Apple",
    icon: "Mail",
    imapHost: "imap.mail.me.com",
    imapPort: 993,
    smtpHost: "smtp.mail.me.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    color: "#555555",
    authMethod: "password",
    appPasswordUrl: "https://appleid.apple.com/account/manage",
  },
  {
    id: "fastmail",
    name: "Fastmail",
    icon: "Mail",
    imapHost: "imap.fastmail.com",
    imapPort: 993,
    smtpHost: "smtp.fastmail.com",
    smtpPort: 587,
    smtpSecurity: "starttls",
    color: "#69639f",
    authMethod: "password",
  },
  {
    id: "protonmail",
    name: "ProtonMail",
    icon: "Mail",
    imapHost: "127.0.0.1",
    imapPort: 1143,
    smtpHost: "127.0.0.1",
    smtpPort: 1025,
    smtpSecurity: "starttls",
    color: "#6d4aff",
    authMethod: "password",
  },
  {
    id: "webde",
    name: "WEB.DE",
    icon: "Mail",
    imapHost: "imap.web.de",
    imapPort: 993,
    smtpHost: "smtp.web.de",
    smtpPort: 587,
    smtpSecurity: "starttls",
    color: "#ffd800",
    authMethod: "password",
    appPasswordUrl: "https://web.de/email/sicherheit/",
  },
  {
    id: "gmx",
    name: "GMX",
    icon: "Mail",
    imapHost: "imap.gmx.net",
    imapPort: 993,
    smtpHost: "mail.gmx.net",
    smtpPort: 587,
    smtpSecurity: "starttls",
    color: "#1c449b",
    authMethod: "password",
    appPasswordUrl: "https://gmx.net/email/sicherheit/",
  },
  {
    id: "custom",
    name: "Custom",
    icon: "Settings",
    imapHost: "",
    imapPort: 993,
    smtpHost: "",
    smtpPort: 465,
    smtpSecurity: "ssl",
    color: "#3b82f6",
    authMethod: "password",
  },
];
