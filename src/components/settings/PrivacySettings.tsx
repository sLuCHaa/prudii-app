import { Shield, Eye, Image, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../../stores/appStore";
import { useAccounts } from "../../hooks/useAccounts";
import { updateAccountSettings } from "../../lib/tauri";
import type { Account, AppSettings } from "../../types";

interface PrivacySettingsProps {
  localSettings: AppSettings;
  updateLocalSetting: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) => void;
}

export function PrivacySettings({ localSettings, updateLocalSetting }: PrivacySettingsProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);
  const trackersBlockedCount = useAppStore((s) => s.trackersBlockedCount);
  const { data: accounts } = useAccounts();

  // Saves immediately — these are account rows, not app settings, so they
  // do not participate in the panel's Save-button dirty flow.
  async function handleImageSetting(account: Account, value: "always" | "never") {
    if ((account.load_external_images || "always") === value) return;
    try {
      await updateAccountSettings(
        account.id,
        account.display_name,
        account.color,
        account.imap_host,
        account.imap_port,
        account.smtp_host,
        account.smtp_port,
        account.smtp_security,
        value
      );
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
    } catch (err) {
      addToast("error", t("settings.privacy.imageSaveFailed"), err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <>
      {/* Tracker protection (always on, informational) */}
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Shield className="w-4 h-4 text-text-tertiary" />
          <h3 className="text-sm font-medium text-text">{t("settings.privacy.trackerBlocking")}</h3>
        </div>
        <p className="text-xs text-text-tertiary mb-3">
          {t("settings.privacy.trackerBlockingDesc")}
        </p>
        <div className="flex items-center justify-between p-3 rounded-lg border border-border">
          <div className="flex items-center gap-2">
            <Eye className="w-4 h-4 text-text-tertiary" />
            <span className="text-sm text-text">{t("privacy.trackersBlocked")}</span>
          </div>
          <span className="text-sm font-mono text-text-secondary">{trackersBlockedCount}</span>
        </div>
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <Image className="w-4 h-4 text-text-tertiary" />
          <h3 className="text-sm font-medium text-text">{t("settings.privacy.externalImages")}</h3>
        </div>
        <p className="text-xs text-text-tertiary mb-3">
          {t("settings.privacy.externalImagesDesc")}
        </p>
        {accounts && accounts.length > 0 ? (
          <div className="space-y-2">
            {accounts.map((account) => (
              <div key={account.id} className="flex items-center gap-3 p-3 rounded-lg border border-border">
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ backgroundColor: account.color }}
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-text truncate">{account.display_name}</div>
                  <div className="text-xs text-text-tertiary truncate">{account.email}</div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button
                    onClick={() => handleImageSetting(account, "always")}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                      (account.load_external_images || "always") === "always"
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-border text-text-secondary hover:bg-hover"
                    }`}
                  >
                    {t("settings.account.loadImagesAlways")}
                  </button>
                  <button
                    onClick={() => handleImageSetting(account, "never")}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                      account.load_external_images === "never"
                        ? "border-accent bg-accent-soft text-accent"
                        : "border-border text-text-secondary hover:bg-hover"
                    }`}
                  >
                    {t("settings.account.loadImagesNever")}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-text-tertiary">{t("settings.accounts.noAccounts")}</p>
        )}
      </div>

      {/* Link cleaning (app setting, saved via panel Save button) */}
      <div>
        <label className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors cursor-pointer">
          <Link2 className="w-4 h-4 text-text-tertiary shrink-0" />
          <div className="flex-1">
            <div className="text-sm text-text">{t("settings.privacy.stripTrackingParams")}</div>
            <div className="text-xs text-text-tertiary">{t("settings.privacy.stripTrackingParamsDesc")}</div>
          </div>
          <input
            type="checkbox"
            checked={localSettings.strip_tracking_params}
            onChange={(e) => updateLocalSetting("strip_tracking_params", e.target.checked)}
            className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
          />
        </label>
      </div>
    </>
  );
}
