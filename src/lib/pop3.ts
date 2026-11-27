import type { TFunction } from "i18next";
import type { Account, IncomingProtocol, IncomingSecurity, IncomingSettings, Pop3DeleteMode } from "../types";
import type { ProviderPreset } from "./providers";

export interface Pop3Rule {
  mode: Pop3DeleteMode;
  days: number;
  withLocal: boolean;
}

export const DEFAULT_POP3_RULE: Pop3Rule = { mode: "after_days", days: 14, withLocal: true };

const MODE_SENTENCE: Record<Pop3DeleteMode, string> = {
  keep: "pop3.rule.keep",
  after_fetch: "pop3.rule.afterFetch",
  after_days: "pop3.rule.afterDays",
};

export function supportsPop3(preset: ProviderPreset): boolean {
  return preset.id === "custom" || !!preset.pop3Host;
}

export function defaultPop3Port(security: IncomingSecurity): number {
  return security === "ssl" ? 995 : 110;
}

export function switchPop3Port(port: number, security: IncomingSecurity): number {
  return port === 995 || port === 110 ? defaultPop3Port(security) : port;
}

export function clampDeleteDays(value: number): number {
  if (Number.isNaN(value)) return DEFAULT_POP3_RULE.days;
  return Math.min(365, Math.max(1, Math.trunc(value)));
}

export function describePop3Rule(t: TFunction, rule: Pop3Rule): string {
  const mode = t(MODE_SENTENCE[rule.mode], { count: rule.days });
  const local = t(rule.withLocal ? "pop3.rule.withLocal" : "pop3.rule.withoutLocal");
  return `${mode} ${local}`;
}

export function ruleFromAccount(a: IncomingSettings): Pop3Rule {
  return { mode: a.pop3_delete_mode, days: a.pop3_delete_after_days, withLocal: a.pop3_delete_with_local };
}

export function ruleToSettings(
  r: Pop3Rule,
): Pick<IncomingSettings, "pop3_delete_mode" | "pop3_delete_after_days" | "pop3_delete_with_local"> {
  return {
    pop3_delete_mode: r.mode,
    pop3_delete_after_days: clampDeleteDays(r.days),
    pop3_delete_with_local: r.withLocal,
  };
}

export function accountSetupError(
  t: TFunction,
  raw: string,
  protocol: IncomingProtocol,
  accounts: Pick<Account, "email" | "incoming_protocol">[],
): string {
  const [code, email = "", existingProvider = ""] = raw.split("|");
  if (code === "EMAIL_PROVIDER_CONFLICT") {
    const other = accounts.find(
      (a) => a.email.toLowerCase() === email.toLowerCase() && a.incoming_protocol !== protocol,
    );
    if (other) {
      return t("pop3.error.protocolConflict", { email, protocol: other.incoming_protocol.toUpperCase() });
    }
    const providerLabel =
      existingProvider === "google" ? "Google" :
      existingProvider === "microsoft" ? "Microsoft" :
      existingProvider.toUpperCase();
    return t("wizard.emailConflict", { email, existingProvider: providerLabel });
  }
  if (code === "POP3_ACCOUNT_EXISTS") return t("pop3.error.accountExists", { email });
  if (code === "PROTOCOL_CHANGE_UNSUPPORTED") return t("pop3.error.protocolChange");
  return raw;
}
