import { useState, useEffect } from "react";
import { Key, LogOut, Monitor, Crown, Users, ExternalLink, Copy, Check, Shield, AlertTriangle, RefreshCw } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { licenseLogin, licenseLogout, getLicenseInfo, verifyLicense, activateLicenseKey, getDeviceId } from "../../lib/tauri";
import { useAppStore } from "../../stores/appStore";
import { Button } from "../ui/Button";
import type { LicenseInfo } from "../../types";

type LicenseView = "main" | "login" | "activate";

export function LicenseSettings() {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const [license, setLicenseLocal] = useState<LicenseInfo | null>(null);
  const [view, setView] = useState<LicenseView>("main");
  const [error, setError] = useState("");
  const queryClient = useQueryClient();

  // Sync license to local state, global store, AND the query cache so
  // revisiting the tab within staleTime shows the post-action state.
  function setLicense(info: LicenseInfo | null) {
    setLicenseLocal(info);
    useAppStore.getState().setLicenseInfo(info);
    if (info) queryClient.setQueryData(["license-info"], info);
  }

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loginLoading, setLoginLoading] = useState(false);

  const [licenseKey, setLicenseKey] = useState("");
  const [activateEmail, setActivateEmail] = useState("");
  const [activateLoading, setActivateLoading] = useState(false);

  const [copied, setCopied] = useState(false);

  const licenseQuery = useQuery({
    queryKey: ["license-info"],
    queryFn: getLicenseInfo,
    staleTime: 300_000,
    retry: false,
  });
  const { data: deviceId = "" } = useQuery({
    queryKey: ["device-id"],
    queryFn: getDeviceId,
    staleTime: Infinity,
    retry: false,
  });
  const loading = licenseQuery.isLoading;

  useEffect(() => {
    const info = licenseQuery.data;
    if (!info) return;
    setLicense(info);
    if (info.logged_in) setView("main");
    // Prefill the email so re-login after a session expiry is one step.
    if (info.session_expired && info.user_email) setEmail(info.user_email);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licenseQuery.data]);

  useEffect(() => {
    if (licenseQuery.isError) {
      const err = licenseQuery.error;
      addToast("error", t("errors.licenseLoad"), err instanceof Error ? err.message : String(err));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [licenseQuery.isError]);

  async function handleLogin() {
    if (!email || !password) return;
    setLoginLoading(true);
    setError("");
    try {
      const info = await licenseLogin(email, password);
      setLicense(info);
      setView("main");
      setEmail("");
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoginLoading(false);
    }
  }

  async function handleLogout() {
    try {
      await licenseLogout();
      setLicense(null);
      await queryClient.refetchQueries({ queryKey: ["license-info"] });
    } catch (err) {
      addToast("error", t("errors.licenseLogout"), err instanceof Error ? err.message : String(err));
    }
  }

  async function handleActivate() {
    if (!licenseKey || !activateEmail) return;
    setActivateLoading(true);
    setError("");
    try {
      const info = await activateLicenseKey(licenseKey, activateEmail);
      setLicense(info);
      setView("main");
      setLicenseKey("");
      setActivateEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActivateLoading(false);
    }
  }

  const [verifyLoading, setVerifyLoading] = useState(false);
  const [verifySuccess, setVerifySuccess] = useState(false);

  async function handleVerify() {
    setVerifyLoading(true);
    setVerifySuccess(false);
    setError("");
    try {
      const info = await verifyLicense();
      setLicense(info);
      setVerifySuccess(true);
      setTimeout(() => setVerifySuccess(false), 3000);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A 401 clears the token on the backend; re-read so the UI reflects the
      // expired session (locked features + re-login prompt) right away.
      try {
        const info = await getLicenseInfo();
        setLicense(info);
        if (info.session_expired && info.user_email) setEmail(info.user_email);
      } catch { /* ignore */ }
    } finally {
      setVerifyLoading(false);
    }
  }

  function copyKey() {
    if (license?.license_key) {
      navigator.clipboard.writeText(license.license_key);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  function getPlanIcon() {
    if (!license) return <Shield className="w-5 h-5" />;
    switch (license.plan) {
      case "team": return <Users className="w-5 h-5" />;
      case "premium": return <Crown className="w-5 h-5" />;
      default: return <Shield className="w-5 h-5" />;
    }
  }

  function getPlanColor() {
    if (!license) return "text-text-tertiary";
    switch (license.plan) {
      case "team": return "text-green-500";
      case "premium": return "text-purple-500";
      default: return "text-text-tertiary";
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="animate-spin w-5 h-5 border-2 border-accent border-t-transparent rounded-full" />
      </div>
    );
  }

  if (view === "login") {
    return (
      <div>
        <h3 className="text-sm font-medium text-text mb-1">{t("settings.license.loginTitle")}</h3>
        <p className="text-xs text-text-tertiary mb-4">{t("settings.license.loginDesc")}</p>

        {license?.session_expired && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-500/10 border border-amber-500/20 mb-4">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            <p className="text-xs text-amber-600 dark:text-amber-400">{t("settings.license.sessionExpired")}</p>
          </div>
        )}

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 mb-4">
            <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
            <p className="text-xs text-red-500">{error}</p>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="text-xs text-text-tertiary mb-1 block">{t("settings.license.email")}</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm focus:border-accent"
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            />
          </div>
          <div>
            <label className="text-xs text-text-tertiary mb-1 block">{t("settings.license.password")}</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm focus:border-accent"
              onKeyDown={(e) => e.key === "Enter" && handleLogin()}
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={loginLoading}
              onClick={handleLogin}
            >
              {t("settings.license.login")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { setView("main"); setError(""); }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-border">
          <button
            onClick={() => { setView("activate"); setError(""); }}
            className="text-xs text-accent hover:underline"
          >
            {t("settings.license.activateKeyInstead")}
          </button>
        </div>
      </div>
    );
  }

  if (view === "activate") {
    return (
      <div>
        <h3 className="text-sm font-medium text-text mb-1">{t("settings.license.activateTitle")}</h3>
        <p className="text-xs text-text-tertiary mb-4">{t("settings.license.activateDesc")}</p>

        {error && (
          <div className="flex items-center gap-2 p-3 rounded-lg bg-red-500/10 border border-red-500/20 mb-4">
            <AlertTriangle className="w-4 h-4 text-red-500 shrink-0" />
            <p className="text-xs text-red-500">{error}</p>
          </div>
        )}

        <div className="space-y-3">
          <div>
            <label className="text-xs text-text-tertiary mb-1 block">{t("settings.license.licenseKey")}</label>
            <input
              type="text"
              value={licenseKey}
              onChange={(e) => setLicenseKey(e.target.value.toUpperCase())}
              placeholder="PRUDII-XXXXX-XXXXX-XXXXX-XXXXX"
              className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm font-mono focus:border-accent"
            />
          </div>
          <div>
            <label className="text-xs text-text-tertiary mb-1 block">{t("settings.license.email")}</label>
            <input
              type="email"
              value={activateEmail}
              onChange={(e) => setActivateEmail(e.target.value)}
              placeholder="you@example.com"
              className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm focus:border-accent"
            />
          </div>
          <div className="flex gap-2">
            <Button
              variant="primary"
              size="sm"
              loading={activateLoading}
              onClick={handleActivate}
              icon={<Key />}
            >
              {t("settings.license.activate")}
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { setView("main"); setError(""); }}
            >
              {t("common.cancel")}
            </Button>
          </div>
        </div>

        <div className="mt-4 pt-4 border-t border-border">
          <button
            onClick={() => { setView("login"); setError(""); }}
            className="text-xs text-accent hover:underline"
          >
            {t("settings.license.loginInstead")}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-text mb-1">{t("settings.license.title")}</h3>
      <p className="text-xs text-text-tertiary mb-4">{t("settings.license.description")}</p>

      {!license?.logged_in && (
        <div className="space-y-3">
          <div className="p-4 rounded-lg border border-border">
            <div className="flex items-center gap-3 mb-3">
              <Shield className="w-5 h-5 text-text-tertiary" />
              <div>
                <div className="text-sm font-medium text-text">{t("settings.license.freePlan")}</div>
                <div className="text-xs text-text-tertiary">{t("settings.license.freePlanDesc")}</div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button variant="primary" size="sm" onClick={() => setView("login")}>
                {t("settings.license.login")}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setView("activate")} icon={<Key />}>
                {t("settings.license.activateKey")}
              </Button>
            </div>
          </div>
        </div>
      )}

      {license?.logged_in && (
        <div className="space-y-3">
          {/* Auth token expired/rejected — a soft hint. Paid features stay available
              under the grace period; signing in again just refreshes the session. */}
          {license.session_expired && (
            <div className="p-4 rounded-lg border border-amber-500/30 bg-amber-500/10 space-y-3">
              <div className="flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
                <p className="text-xs text-amber-600 dark:text-amber-400">{t("settings.license.sessionExpired")}</p>
              </div>
              <Button variant="primary" size="sm" onClick={() => { setError(""); setView("login"); }}>
                {t("settings.license.login")}
              </Button>
            </div>
          )}

          <div className="p-4 rounded-lg border border-border">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-3">
                <span className={getPlanColor()}>{getPlanIcon()}</span>
                <div>
                  <div className="text-sm font-medium text-text capitalize">{license.plan}</div>
                  <div className="text-xs text-text-tertiary">{license.user_email}</div>
                </div>
              </div>
              {license.plan === "free" && (
                <a
                  href="https://prudii.com/#pricing"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs text-accent hover:underline flex items-center gap-1"
                >
                  {t("settings.license.upgrade")}
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}
            </div>

            {license.plan !== "free" && (
              <div className="space-y-2 pt-2 border-t border-border">
                {license.license_key && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-tertiary">{t("settings.license.licenseKey")}</span>
                    <div className="flex items-center gap-1">
                      <span className="text-xs font-mono text-text">{license.license_key}</span>
                      <button onClick={copyKey} className="p-1 hover:bg-hover rounded">
                        {copied ? <Check className="w-3 h-3 text-green-500" /> : <Copy className="w-3 h-3 text-text-tertiary" />}
                      </button>
                    </div>
                  </div>
                )}
                {license.valid_until && (
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-text-tertiary">{t("settings.license.validUntil")}</span>
                    <span className="text-xs text-text">{new Date(license.valid_until).toLocaleDateString()}</span>
                  </div>
                )}
                <div className="pt-2">
                    <a
                      href="https://prudii.com/dashboard/billing"
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-accent hover:underline flex items-center gap-1"
                    >
                      {t("settings.license.manageBilling")}
                      <ExternalLink className="w-3 h-3" />
                    </a>
                  </div>
              </div>
            )}
          </div>

          <div className="p-3 rounded-lg border border-border">
            <div className="flex items-center gap-2 mb-2">
              <Monitor className="w-4 h-4 text-text-tertiary" />
              <span className="text-xs font-medium text-text">{t("settings.license.device")}</span>
            </div>
            <div className="text-xs text-text-tertiary font-mono">{deviceId || license.device_id}</div>
          </div>

          <div className="p-3 rounded-lg border border-border space-y-2">
            <div className="flex items-center justify-between">
              <span className="text-xs text-text-tertiary">{t("settings.license.lastVerified")}</span>
              <span className="text-xs text-text">
                {license.last_verified ? new Date(license.last_verified).toLocaleString() : "—"}
              </span>
            </div>
            {error && (
              <div className="flex items-center gap-2 p-2 rounded bg-red-500/10 border border-red-500/20">
                <AlertTriangle className="w-3 h-3 text-red-500 shrink-0" />
                <p className="text-xs text-red-500">{error}</p>
              </div>
            )}
            {verifySuccess && (
              <div className="flex items-center gap-2 p-2 rounded bg-green-500/10 border border-green-500/20">
                <Check className="w-3 h-3 text-green-500 shrink-0" />
                <p className="text-xs text-green-500">{t("settings.license.verifySuccess")}</p>
              </div>
            )}
            <Button variant="secondary" size="sm" loading={verifyLoading} onClick={handleVerify} icon={<RefreshCw />}>
              {t("settings.license.refreshLicense")}
            </Button>
          </div>

          <div className="pt-2">
            <Button variant="secondary" size="sm" onClick={handleLogout} icon={<LogOut />}>
              {t("settings.license.logout")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
