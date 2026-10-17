import { Shield, Eye, Image } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../../stores/appStore";
import { useAccounts } from "../../hooks/useAccounts";
import { updateAccountSettings } from "../../lib/tauri";
import { Switch } from "../ui/Switch";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SettingsGroup, SettingsBlock, SettingsRow } from "./SettingsGroup";
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
      <SettingsGroup title={t("settings.privacy.trackerBlocking")} icon={<Shield className="w-4 h-4" />}>
        <SettingsBlock description={t("settings.privacy.trackerBlockingDesc")} />
        <SettingsRow
          as="div"
          icon={<Eye className="w-4 h-4 text-text-tertiary shrink-0" />}
          title={t("privacy.trackersBlocked")}
          control={<span className="text-sm font-mono text-text-secondary">{trackersBlockedCount}</span>}
        />
        <SettingsRow
          title={t("settings.privacy.stripTrackingParams")}
          description={t("settings.privacy.stripTrackingParamsDesc")}
          control={<Switch checked={localSettings.strip_tracking_params} onChange={(v) => updateLocalSetting("strip_tracking_params", v)} />}
        />
      </SettingsGroup>

      <SettingsGroup title={t("settings.privacy.externalImages")} icon={<Image className="w-4 h-4" />}>
        <SettingsBlock description={t("settings.privacy.externalImagesDesc")} />
        {accounts && accounts.length > 0 ? (
          accounts.map((account) => (
            <SettingsRow
              key={account.id}
              as="div"
              icon={
                <span
                  className="w-3 h-3 rounded-full shrink-0"
                  style={{ backgroundColor: account.color }}
                />
              }
              title={<span className="block truncate">{account.display_name}</span>}
              description={<span className="block truncate">{account.email}</span>}
              control={
                <SegmentedControl
                  className="shrink-0"
                  aria-label={`${t("settings.privacy.externalImages")}: ${account.display_name}`}
                  value={(account.load_external_images || "always") === "never" ? "never" : "always"}
                  onChange={(v) => handleImageSetting(account, v)}
                  options={[
                    { value: "always", label: t("settings.account.loadImagesAlways") },
                    { value: "never", label: t("settings.account.loadImagesNever") },
                  ]}
                />
              }
            />
          ))
        ) : (
          <SettingsBlock>
            <p className="text-sm text-text-tertiary">{t("settings.accounts.noAccounts")}</p>
          </SettingsBlock>
        )}
      </SettingsGroup>
    </>
  );
}
