import { useState, useMemo } from "react";
import { Eye, EyeOff, ExternalLink } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { motion } from "motion/react";
import type { ProviderPreset } from "../../lib/providers";
import type { SmtpSecurity } from "../../types";
import { mapImapError } from "../../lib/imapErrorMap";
import { Button } from "../ui/Button";
import { GlowRing } from "../motion/GlowRing";
import { SPRING_BOUNCY } from "../motion/tokens";
import { useTranslation } from "react-i18next";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const ACCOUNT_COLORS = [
  "#3b82f6", "#ef4444", "#10b981", "#f59e0b", "#8b5cf6",
  "#ec4899", "#06b6d4", "#f97316",
];

const inputClass =
  "w-full px-3 py-2 rounded-lg border border-border bg-surface text-text placeholder-text-secondary focus-visible:ring-2 focus-visible:ring-accent focus-visible:border-transparent";

interface WizardStepAuthProps {
  provider: ProviderPreset;
  email: string;
  displayName: string;
  password: string;
  color: string;
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  smtpSecurity: SmtpSecurity;
  usePasswordFallback: boolean;
  oauthDisabled: boolean;
  testError: string | null;
  isSubmitting: boolean;
  onEmailChange: (v: string) => void;
  onDisplayNameChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onColorChange: (v: string) => void;
  onImapHostChange: (v: string) => void;
  onImapPortChange: (v: number) => void;
  onSmtpHostChange: (v: string) => void;
  onSmtpPortChange: (v: number) => void;
  onSmtpSecurityChange: (v: SmtpSecurity) => void;
  onUsePasswordFallback: () => void;
  onBack: () => void;
  onOAuth: () => void;
  onSubmit: (e: React.FormEvent) => void;
}

export function WizardStepAuth({
  provider,
  email,
  displayName,
  password,
  color,
  imapHost,
  imapPort,
  smtpHost,
  smtpPort,
  smtpSecurity,
  usePasswordFallback,
  oauthDisabled,
  testError,
  isSubmitting,
  onEmailChange,
  onDisplayNameChange,
  onPasswordChange,
  onColorChange,
  onImapHostChange,
  onImapPortChange,
  onSmtpHostChange,
  onSmtpPortChange,
  onSmtpSecurityChange,
  onUsePasswordFallback,
  onBack,
  onOAuth,
  onSubmit,
}: WizardStepAuthProps) {
  const { t } = useTranslation();
  const [showPassword, setShowPassword] = useState(false);
  const isValidEmail = useMemo(() => EMAIL_RE.test(email), [email]);
  const swatches = useMemo(
    () => Array.from(new Set([color, ...ACCOUNT_COLORS])),
    [color],
  );

  const isOAuth = provider.authMethod === "oauth" && !usePasswordFallback && !oauthDisabled;
  const handleFormSubmit = isOAuth
    ? (e: React.FormEvent) => { e.preventDefault(); onOAuth(); }
    : onSubmit;

  const errorHint = testError
    ? mapImapError({ message: testError }, { email, provider: provider.id })
    : null;

  return (
    <form onSubmit={handleFormSubmit} className="space-y-4">
      <h3 className="text-lg font-semibold text-text">
        {provider.name}
      </h3>

      {oauthDisabled && provider.authMethod === "oauth" && (
        <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-sm text-text-secondary">
          {t("wizard.oauthAtCapacity", { provider: provider.name })}
          {provider.id === "microsoft" && (
            <span className="block mt-1 text-text-tertiary">
              {t("wizard.oauthAtCapacityMicrosoft")}
            </span>
          )}
        </div>
      )}

      {errorHint && (
        <div className="rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
          <p className="font-semibold text-danger mb-1">{errorHint.title}</p>
          <p className="text-text-secondary">{errorHint.detail}</p>
          {errorHint.link && (
            <a
              href={errorHint.link}
              onClick={(e) => { e.preventDefault(); openUrl(errorHint.link!); }}
              className="inline-block mt-2 text-accent underline text-xs"
            >
              {errorHint.linkLabel}
            </a>
          )}
        </div>
      )}

      {isOAuth ? (
        <>
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              {t("wizard.displayName")}
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => onDisplayNameChange(e.target.value)}
              placeholder="Your Name"
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              {t("wizard.accountColor")}
            </label>
            <div className="flex gap-2">
              {swatches.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onColorChange(c)}
                  className={`w-7 h-7 rounded-full transition-transform ${
                    color === c ? "ring-2 ring-offset-2 ring-text-tertiary scale-110" : ""
                  }`}
                  style={{ backgroundColor: c, "--tw-ring-offset-color": "var(--c-surface)" } as React.CSSProperties}
                />
              ))}
            </div>
          </div>

          <div className="flex gap-2 pt-2">
            <Button type="button" variant="secondary" fullWidth onClick={onBack}>
              {t("common.back")}
            </Button>
            <Button type="submit" variant="primary" fullWidth disabled={isSubmitting} loading={isSubmitting}>
              {t("wizard.signInWith", { provider: provider.name })}
            </Button>
          </div>

          <div className="text-center">
            <button
              type="button"
              onClick={onUsePasswordFallback}
              className="text-xs text-text-tertiary hover:text-text-secondary hover:underline"
            >
              {t("wizard.usePassword")}
            </button>
          </div>
        </>
      ) : (
        <>
          {provider.id === "protonmail" && (
            <div className="rounded-lg border border-accent/30 bg-accent/5 p-3 text-xs text-text-secondary">
              {t("wizard.protonBridgeHint")}
            </div>
          )}
          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              {t("wizard.emailAddress")}
            </label>
            <GlowRing active={isValidEmail} intensity={1} className="rounded-lg">
              <input
                type="email"
                value={email}
                onChange={(e) => onEmailChange(e.target.value)}
                required
                placeholder="you@example.com"
                className={inputClass}
              />
            </GlowRing>
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              {t("wizard.password")}
            </label>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => onPasswordChange(e.target.value)}
                required
                placeholder={t("wizard.passwordPlaceholder")}
                className={inputClass + " pr-10"}
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-text-tertiary hover:text-text-secondary"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
            {provider.appPasswordUrl && (
              <p className="text-xs text-text-tertiary mt-1.5">
                {t("wizard.appPasswordHint")}{" "}
                <button
                  type="button"
                  onClick={() => openUrl(provider.appPasswordUrl!)}
                  className="text-accent hover:underline inline-flex items-center gap-0.5"
                >
                  {t("wizard.createAppPassword")}
                  <ExternalLink className="w-3 h-3" />
                </button>
              </p>
            )}
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              {t("wizard.displayName")}
            </label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => onDisplayNameChange(e.target.value)}
              placeholder="Your Name"
              className={inputClass}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-text-secondary mb-1">
              {t("wizard.accountColor")}
            </label>
            <div className="flex gap-2">
              {swatches.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => onColorChange(c)}
                  className={`w-7 h-7 rounded-full transition-transform ${
                    color === c ? "ring-2 ring-offset-2 ring-text-tertiary scale-110" : ""
                  }`}
                  style={{ backgroundColor: c, "--tw-ring-offset-color": "var(--c-surface)" } as React.CSSProperties}
                />
              ))}
            </div>
          </div>

          {provider.id === "custom" && (
            <>
              <motion.div
                className="grid grid-cols-3 gap-2"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...SPRING_BOUNCY, delay: 0 }}
              >
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-text-secondary mb-1">
                    {t("wizard.imapHost")}
                  </label>
                  <input
                    type="text"
                    value={imapHost}
                    onChange={(e) => onImapHostChange(e.target.value)}
                    required
                    placeholder="imap.example.com"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">
                    {t("settings.account.port")}
                  </label>
                  <input
                    type="number"
                    value={imapPort}
                    onChange={(e) => onImapPortChange(Number(e.target.value))}
                    className={inputClass}
                  />
                </div>
              </motion.div>
              <motion.div
                className="grid grid-cols-3 gap-2"
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...SPRING_BOUNCY, delay: 0.08 }}
              >
                <div className="col-span-2">
                  <label className="block text-sm font-medium text-text-secondary mb-1">
                    {t("wizard.smtpHost")}
                  </label>
                  <input
                    type="text"
                    value={smtpHost}
                    onChange={(e) => onSmtpHostChange(e.target.value)}
                    required
                    placeholder="smtp.example.com"
                    className={inputClass}
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-text-secondary mb-1">
                    {t("settings.account.port")}
                  </label>
                  <input
                    type="number"
                    value={smtpPort}
                    onChange={(e) => onSmtpPortChange(Number(e.target.value))}
                    className={inputClass}
                  />
                </div>
              </motion.div>
              <motion.div
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ ...SPRING_BOUNCY, delay: 0.16 }}
              >
                <label className="block text-sm font-medium text-text-secondary mb-1">
                  {t("settings.account.smtpSecurity")}
                </label>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      onSmtpSecurityChange("ssl");
                      if (smtpPort === 587) onSmtpPortChange(465);
                    }}
                    className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      smtpSecurity === "ssl"
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border text-text-secondary hover:bg-hover"
                    }`}
                  >
                    SSL/TLS (Port 465)
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onSmtpSecurityChange("starttls");
                      if (smtpPort === 465) onSmtpPortChange(587);
                    }}
                    className={`flex-1 px-3 py-2 rounded-lg border text-sm font-medium transition-colors ${
                      smtpSecurity === "starttls"
                        ? "border-accent bg-accent/10 text-accent"
                        : "border-border text-text-secondary hover:bg-hover"
                    }`}
                  >
                    STARTTLS (Port 587)
                  </button>
                </div>
              </motion.div>
            </>
          )}

          <div className="flex gap-2 pt-2">
            <Button type="button" variant="secondary" fullWidth onClick={onBack}>
              {t("common.back")}
            </Button>
            <Button type="submit" variant="primary" fullWidth disabled={isSubmitting} loading={isSubmitting}>
              {t("common.connect")}
            </Button>
          </div>
        </>
      )}
    </form>
  );
}
