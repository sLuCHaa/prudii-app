import { useState, useEffect, useRef } from "react";
import { X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { motion } from "motion/react";
import type { ProviderPreset } from "../../lib/providers";
import { useCreateAccount } from "../../hooks/useAccounts";
import { useSyncAccount } from "../../hooks/useSync";
import { useAppConfig } from "../../hooks/useAppConfig";
import { useAppStore } from "../../stores/appStore";
import { testImapConnection, startOAuth } from "../../lib/tauri";
import { IconButton } from "../ui/Button";
import { useTranslation } from "react-i18next";
import type { SmtpSecurity, SyncProgress } from "../../types";
import { WizardStepProvider } from "./WizardStepProvider";
import { WizardStepAuth } from "./WizardStepAuth";
import { WizardStepTesting } from "./WizardStepTesting";
import { WizardStepDone } from "./WizardStepDone";
import { GlowRing } from "../motion/GlowRing";
import { SPRING_BOUNCY } from "../motion/tokens";

type WizardStep = "provider" | "credentials" | "oauth_waiting" | "testing" | "done";

const STEP_KEYS = ["wizard.stepProvider", "wizard.stepAuth", "wizard.stepSync", "wizard.stepDone"];

const STEP_INDEX: Record<string, number> = {
  provider: 0,
  credentials: 1,
  oauth_waiting: 2,
  testing: 2,
  done: 3,
};

function StepperHeader({ current }: { current: number }) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center justify-center gap-3 py-6">
      {STEP_KEYS.map((labelKey, i) => {
        const isActive = i === current;
        const isDone = i < current;
        return (
          <div key={labelKey} className="flex items-center gap-3">
            <div className="flex flex-col items-center gap-1">
              <GlowRing active={isActive} intensity={2}>
                <motion.div
                  className="w-9 h-9 rounded-full flex items-center justify-center font-semibold text-sm"
                  animate={{
                    background: isDone || isActive ? "var(--c-accent)" : "var(--c-bg-tertiary)",
                    color: isDone || isActive ? "#fff" : "var(--c-text-secondary)",
                    scale: isActive ? 1.1 : 1,
                  }}
                  transition={SPRING_BOUNCY}
                >
                  {isDone ? "✓" : i + 1}
                </motion.div>
              </GlowRing>
              <span className="text-[10px] text-text-tertiary font-medium">{t(labelKey)}</span>
            </div>
            {i < STEP_KEYS.length - 1 && (
              <div className="w-12 h-[2px] rounded-full bg-bg-tertiary overflow-hidden mb-4">
                <motion.div
                  className="h-full bg-accent"
                  initial={false}
                  animate={{ width: isDone ? "100%" : "0%" }}
                  transition={{ duration: 0.4, ease: "easeOut" }}
                />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function AccountWizard() {
  const { setShowAccountWizard } = useAppStore();
  const createAccount = useCreateAccount();
  const syncAccount = useSyncAccount();
  const { data: appConfig } = useAppConfig();

  const [step, setStep] = useState<WizardStep>("provider");
  const [provider, setProvider] = useState<ProviderPreset | null>(null);
  const [email, setEmail] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [password, setPassword] = useState("");
  const [color, setColor] = useState("#3b82f6");
  const [imapHost, setImapHost] = useState("");
  const [imapPort, setImapPort] = useState(993);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(465);
  const [smtpSecurity, setSmtpSecurity] = useState<SmtpSecurity>("ssl");
  const [usePasswordFallback, setUsePasswordFallback] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testStatus, setTestStatus] = useState<string>("");
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  const [createdAccountId, setCreatedAccountId] = useState<string | null>(null);
  const [showOnboarding, setShowOnboarding] = useState(false);
  const stepRef = useRef(step);
  stepRef.current = step;
  const createdAccountIdRef = useRef<string | null>(null);
  createdAccountIdRef.current = createdAccountId;
  const authTypeRef = useRef<"oauth" | "password" | null>(null);
  const { t } = useTranslation();

  // Listen for sync progress events — drives the wizard forward on "done" / "error".
  // Registered once; reads live ids/step via refs to avoid a re-subscribe race that
  // could drop early progress events. `t` is intentionally pinned at mount (don't add
  // it to the deps — that would re-subscribe and reintroduce the race); a mid-sync
  // language change only affects the one PERMISSION_DENIED string, which is acceptable.
  useEffect(() => {
    const unlisten = listen<SyncProgress>("sync-progress", (event) => {
      const p = event.payload;
      const currentId = createdAccountIdRef.current;
      if (!currentId || p.account_id !== currentId) return;

      if (p.status === "skipped") return;
      if (p.status === "done") {
        setStep("done");
        if (!localStorage.getItem("prudii-onboarding-seen")) {
          setShowOnboarding(true);
          localStorage.setItem("prudii-onboarding-seen", "true");
        }
      } else if (p.status === "error") {
        setTestError(p.message === "PERMISSION_DENIED" ? t("wizard.permissionDenied") : p.message);
      } else if (stepRef.current === "testing") {
        setTestStatus(p.message);
        setSyncProgress(p);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function oauthClosedFor(id: string): boolean {
    if (id === "google") return appConfig?.oauthSignupGoogle === false;
    if (id === "microsoft") return appConfig?.oauthSignupMicrosoft === false;
    return false;
  }

  function handleProviderSelect(p: ProviderPreset) {
    setProvider(p);
    setImapHost(p.imapHost);
    setImapPort(p.imapPort);
    setSmtpHost(p.smtpHost);
    setSmtpPort(p.smtpPort);
    setSmtpSecurity(p.smtpSecurity);
    setColor(p.color);
    setUsePasswordFallback(oauthClosedFor(p.id));
    setStep("credentials");
  }

  function formatError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    if (raw.startsWith("EMAIL_PROVIDER_CONFLICT|")) {
      const [, email, existingProvider] = raw.split("|");
      const providerLabel =
        existingProvider === "google" ? "Google" :
        existingProvider === "microsoft" ? "Microsoft" :
        existingProvider.toUpperCase();
      return t("wizard.emailConflict", { email, existingProvider: providerLabel });
    }
    return raw;
  }

  async function handleOAuth() {
    if (!provider) return;
    authTypeRef.current = "oauth";

    setStep("oauth_waiting");
    setTestError(null);

    try {
      const result = await startOAuth(provider.id);

      setEmail(result.email);
      setPassword(result.refresh_token);

      setStep("testing");
      setTestStatus(t("wizard.creatingAccount"));

      const account = await createAccount.mutateAsync({
        email: result.email,
        display_name: displayName || result.email.split("@")[0],
        provider: provider.id,
        color,
        imap_host: imapHost,
        imap_port: imapPort,
        smtp_host: smtpHost,
        smtp_port: smtpPort,
        smtp_security: smtpSecurity,
        password: result.refresh_token,
        auth_type: "oauth",
      });

      setCreatedAccountId(account.id);
      setTestStatus(t("wizard.syncingEmails"));
      syncAccount.mutate({ accountId: account.id });
    } catch (err) {
      setStep("credentials");
      setTestError(formatError(err));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!provider) return;
    authTypeRef.current = "password";

    setStep("testing");
    setTestError(null);
    setTestStatus(t("wizard.testingConnection"));

    try {
      await testImapConnection(imapHost, imapPort, email, password);
      setTestStatus(t("wizard.creatingAccount"));

      const account = await createAccount.mutateAsync({
        email,
        display_name: displayName || email.split("@")[0],
        provider: provider.id,
        color,
        imap_host: imapHost,
        imap_port: imapPort,
        smtp_host: smtpHost,
        smtp_port: smtpPort,
        smtp_security: smtpSecurity,
        password,
        auth_type: "password",
      });

      setCreatedAccountId(account.id);
      setTestStatus(t("wizard.syncingEmails"));
      syncAccount.mutate({ accountId: account.id, password });
    } catch (err) {
      setTestError(formatError(err));
    }
  }

  function handleRetry() {
    setTestError(null);
    setSyncProgress(null);
    // If the account already exists, only the sync failed — re-sync instead of
    // re-creating (which would hit a duplicate-account error, and for OAuth would
    // wrongly attempt a password login with the refresh token).
    if (createdAccountId) {
      setTestStatus(t("wizard.syncingEmails"));
      if (authTypeRef.current === "oauth") {
        syncAccount.mutate({ accountId: createdAccountId });
      } else {
        syncAccount.mutate({ accountId: createdAccountId, password });
      }
    } else {
      handleSubmit({ preventDefault: () => {} } as React.FormEvent);
    }
  }

  function close() {
    setShowAccountWizard(false);
  }

  return (
    <div className="fixed inset-0 modal-backdrop flex items-center justify-center z-50">
      <div className="bg-surface rounded-xl w-full max-w-xl mx-4 overflow-hidden max-h-[90vh] flex flex-col" style={{ boxShadow: "var(--shadow-lg)" }}>
        <div className="flex items-center justify-between p-4 border-b border-border">
          <h2 className="text-lg font-semibold text-text">{t("wizard.addAccount")}</h2>
          <IconButton
            icon={<X />}
            aria-label={t("common.close")}
            onClick={close}
          />
        </div>

        <StepperHeader current={STEP_INDEX[step] ?? 0} />

        <div className="p-4 flex-1 overflow-y-auto scrollbar-thin">
          {step === "provider" && (
            <WizardStepProvider onSelect={handleProviderSelect} />
          )}

          {step === "credentials" && provider && (
            <WizardStepAuth
              provider={provider}
              email={email}
              displayName={displayName}
              password={password}
              color={color}
              imapHost={imapHost}
              imapPort={imapPort}
              smtpHost={smtpHost}
              smtpPort={smtpPort}
              smtpSecurity={smtpSecurity}
              usePasswordFallback={usePasswordFallback}
              oauthDisabled={provider ? oauthClosedFor(provider.id) : false}
              testError={testError}
              isSubmitting={createAccount.isPending}
              onEmailChange={setEmail}
              onDisplayNameChange={setDisplayName}
              onPasswordChange={setPassword}
              onColorChange={setColor}
              onImapHostChange={setImapHost}
              onImapPortChange={setImapPort}
              onSmtpHostChange={setSmtpHost}
              onSmtpPortChange={setSmtpPort}
              onSmtpSecurityChange={setSmtpSecurity}
              onUsePasswordFallback={() => { setUsePasswordFallback(true); }}
              onBack={() => setStep("provider")}
              onOAuth={handleOAuth}
              onSubmit={handleSubmit}
            />
          )}

          {(step === "oauth_waiting" || step === "testing") && (
            <WizardStepTesting
              phase={step}
              testStatus={testStatus}
              testError={testError}
              syncProgress={syncProgress}
              email={email}
              providerId={provider?.id}
              onBack={() => { setStep("credentials"); setTestError(null); }}
              onRetry={handleRetry}
              onSyncInBackground={close}
            />
          )}

          {step === "done" && (
            <WizardStepDone
              email={email}
              name={displayName || undefined}
              mailCount={syncProgress?.new_mails ?? 0}
              folderCount={syncProgress?.folder_count ?? 0}
              showOnboarding={showOnboarding}
              onClose={close}
            />
          )}
        </div>
      </div>
    </div>
  );
}
