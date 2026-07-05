import { useState, useEffect, useRef } from "react";
import { X, Sun, Moon, Monitor, Trash2, ChevronRight, ArrowLeft, Save, RefreshCw, Server, Palette, Clock, FolderOpen, Power, AppWindow, Globe, Bell, Volume2, Image, Settings2, Users, Database, Filter, Info, Sparkles, Mail, Key, FileType, Lock, Send, Download, Eye, EyeOff, Plus, PanelLeft, Shield } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../../stores/appStore";
import { useAccounts, useDeleteAccount } from "../../hooks/useAccounts";
import { useScroller } from "../../hooks/useScroller";
import { updateAccountSignature, updateAccountSyncInterval, updateAccountSettings, storeAccountPassword, getAppSettings, updateAppSettings, registerMailtoHandler, unregisterMailtoHandler, isMailtoHandler } from "../../lib/tauri";
import { changeLanguage, getLanguagePreference, type AppLanguage } from "../../lib/i18n";
import { SignatureEditor } from "./SignatureEditor";
import { BackupRestore } from "./BackupRestore";
import { RulesPanel } from "./RulesPanel";
import { AiSettings } from "./AiSettings";
import { PrivacySettings } from "./PrivacySettings";
import { LicenseSettings } from "./LicenseSettings";
import { TemplatesPanel } from "./TemplatesPanel";
import { UpdatePanel } from "./UpdatePanel";
import { PremiumBadge } from "../ui/PremiumBadge";
import { getVersion } from "@tauri-apps/api/app";
import { Button, IconButton } from "../ui/Button";
import { TabButton } from "../ui/TabButton";
import { useDialog } from "../ui/DialogProvider";
import { isMacOS } from "../../lib/platform";
import type { Account, SmtpSecurity } from "../../types";

type ThemeMode = "light" | "dark" | "system";
type SettingsView = "main" | "account";
type SettingsTab = "general" | "privacy" | "accounts" | "rules" | "templates" | "backup" | "ai" | "license" | "update" | "info";

const SETTINGS_TABS: { id: SettingsTab; labelKey: string; icon: typeof Settings2; premium?: boolean }[] = [
  { id: "general", labelKey: "settings.tabs.general", icon: Settings2 },
  { id: "privacy", labelKey: "settings.tabs.privacy", icon: Shield },
  { id: "accounts", labelKey: "settings.tabs.accounts", icon: Users },
  { id: "rules", labelKey: "settings.tabs.rules", icon: Filter, premium: true },
  { id: "templates", labelKey: "settings.tabs.templates", icon: FileType, premium: true },
  { id: "backup", labelKey: "settings.tabs.backup", icon: Database },
  { id: "ai", labelKey: "settings.tabs.ai", icon: Sparkles, premium: true },
  { id: "license", labelKey: "settings.tabs.license", icon: Key },
  { id: "update", labelKey: "settings.tabs.update", icon: Download },
  { id: "info", labelKey: "settings.tabs.info", icon: Info },
];

const THEME_OPTIONS: { mode: ThemeMode; labelKey: string; icon: typeof Sun }[] = [
  { mode: "light", labelKey: "settings.appearance.light", icon: Sun },
  { mode: "dark", labelKey: "settings.appearance.dark", icon: Moon },
  { mode: "system", labelKey: "settings.appearance.system", icon: Monitor },
];

const SYNC_INTERVAL_OPTIONS = [
  { value: 0, labelKey: "settings.account.syncManual" },
  { value: 1, labelKey: "settings.account.syncEveryMinute" },
  { value: 5, labelKey: "settings.account.syncEvery5Min" },
  { value: 15, labelKey: "settings.account.syncEvery15Min" },
  { value: 30, labelKey: "settings.account.syncEvery30Min" },
  { value: 60, labelKey: "settings.account.syncEveryHour" },
];

const LANGUAGE_OPTIONS: { value: AppLanguage; labelKey: string }[] = [
  { value: "system", labelKey: "settings.language.system" },
  { value: "en", labelKey: "settings.language.en" },
  { value: "de", labelKey: "settings.language.de" },
  { value: "es", labelKey: "settings.language.es" },
  { value: "fr", labelKey: "settings.language.fr" },
  { value: "pt", labelKey: "settings.language.pt" },
  { value: "zh", labelKey: "settings.language.zh" },
  { value: "ru", labelKey: "settings.language.ru" },
];

import type { AccentColor, DensityMode } from "../../types";

const ACCENT_COLORS: { id: AccentColor; color: string; label: string }[] = [
  { id: "blue", color: "#3b82f6", label: "Blue" },
  { id: "purple", color: "#8b5cf6", label: "Purple" },
  { id: "green", color: "#10b981", label: "Green" },
  { id: "teal", color: "#14b8a6", label: "Teal" },
  { id: "orange", color: "#f97316", label: "Orange" },
  { id: "pink", color: "#ec4899", label: "Pink" },
  { id: "red", color: "#ef4444", label: "Red" },
  { id: "amber", color: "#f59e0b", label: "Amber" },
];

const DENSITY_OPTIONS: { id: DensityMode; labelKey: string }[] = [
  { id: "compact", labelKey: "settings.density.compact" },
  { id: "comfortable", labelKey: "settings.density.comfortable" },
  { id: "spacious", labelKey: "settings.density.spacious" },
];

const UNDO_SEND_OPTIONS = [
  { value: 0, labelKey: "settings.undoSendOff" },
  { value: 3, label: "3s" },
  { value: 5, label: "5s" },
  { value: 10, label: "10s" },
  { value: 15, label: "15s" },
  { value: 30, label: "30s" },
];

const ACCOUNT_COLORS = [
  "#3b82f6", // blue
  "#8b5cf6", // purple
  "#ec4899", // pink
  "#ef4444", // red
  "#f97316", // orange
  "#eab308", // yellow
  "#22c55e", // green
  "#14b8a6", // teal
  "#06b6d4", // cyan
  "#6b7280", // gray
];

function AccountSettings({
  account,
  onBack,
  dirtyRef,
}: {
  account: Account;
  onBack: () => void;
  dirtyRef: React.MutableRefObject<boolean>;
}) {
  const { t } = useTranslation();
  const scrollRef = useScroller<HTMLDivElement>();
  const addToast = useAppStore((s) => s.addToast);
  const queryClient = useQueryClient();
  const dialog = useDialog();

  const [displayName, setDisplayName] = useState(account.display_name);
  const [color, setColor] = useState(account.color);
  const [imapHost, setImapHost] = useState(account.imap_host);
  const [imapPort, setImapPort] = useState(account.imap_port);
  const [smtpHost, setSmtpHost] = useState(account.smtp_host);
  const [smtpPort, setSmtpPort] = useState(account.smtp_port);
  const [smtpSecurity, setSmtpSecurity] = useState<SmtpSecurity>(account.smtp_security);
  const [loadExternalImages, setLoadExternalImages] = useState(account.load_external_images || "always");

  const [signatureHtml, setSignatureHtml] = useState(account.signature_html);
  const [signatureText, setSignatureText] = useState(account.signature_text);
  const [signatureOnCompose, setSignatureOnCompose] = useState(account.signature_on_compose);
  const [signatureOnReply, setSignatureOnReply] = useState(account.signature_on_reply);
  const [syncInterval, setSyncInterval] = useState(account.sync_interval_minutes);

  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);

  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  // Snapshot of the editable fields at mount — dirty = current differs from
  // snapshot (password counts as dirty when non-empty). No per-handler flags.
  const snapshot = useRef(JSON.stringify({
    displayName: account.display_name,
    color: account.color,
    imapHost: account.imap_host,
    imapPort: account.imap_port,
    smtpHost: account.smtp_host,
    smtpPort: account.smtp_port,
    smtpSecurity: account.smtp_security,
    loadExternalImages: account.load_external_images || "always",
    signatureHtml: account.signature_html,
    signatureText: account.signature_text,
    signatureOnCompose: account.signature_on_compose,
    signatureOnReply: account.signature_on_reply,
    syncInterval: account.sync_interval_minutes,
  }));

  const isDirty = password.trim() !== "" || JSON.stringify({
    displayName, color, imapHost, imapPort, smtpHost, smtpPort, smtpSecurity,
    loadExternalImages, signatureHtml, signatureText, signatureOnCompose,
    signatureOnReply, syncInterval,
  }) !== snapshot.current;

  // Expose dirty state to the parent panel's close guard without re-renders.
  dirtyRef.current = isDirty;
  useEffect(() => () => { dirtyRef.current = false; }, [dirtyRef]);

  async function requestBack() {
    if (isDirty) {
      const confirmed = await dialog.danger({
        title: t("settings.discardTitle"),
        message: t("settings.discardMessage"),
        confirmLabel: t("common.discard"),
        cancelLabel: t("common.cancel"),
      });
      if (!confirmed) return;
    }
    onBack();
  }

  const isOAuth = account.provider === "google" || account.provider === "microsoft";

  async function handleSave() {
    setSaving(true);
    setSaved(false);
    try {
      await updateAccountSettings(
        account.id,
        displayName,
        color,
        imapHost,
        imapPort,
        smtpHost,
        smtpPort,
        smtpSecurity,
        loadExternalImages
      );
      if (password.trim()) {
        await storeAccountPassword(account.id, password);
        setPassword("");
      }
      await updateAccountSignature(account.id, signatureHtml, signatureText, signatureOnCompose, signatureOnReply);
      await updateAccountSyncInterval(account.id, syncInterval);
      queryClient.invalidateQueries({ queryKey: ["accounts"] });
      setSaved(true);
      snapshot.current = JSON.stringify({
        displayName, color, imapHost, imapPort, smtpHost, smtpPort, smtpSecurity,
        loadExternalImages, signatureHtml, signatureText, signatureOnCompose,
        signatureOnReply, syncInterval,
      });
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      addToast("error", t("settings.account.saveFailed"), err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  function handleSignatureChange(html: string, text: string) {
    setSignatureHtml(html);
    setSignatureText(text);
    setSaved(false);
  }

  function handleSyncIntervalChange(value: number) {
    setSyncInterval(value);
    setSaved(false);
  }

  return (
    <>
      <div className="flex items-center gap-3 p-4 border-b border-border">
        <IconButton
          icon={<ArrowLeft />}
          aria-label={t("common.back")}
          onClick={requestBack}
        />
        <div className="flex-1 min-w-0">
          <h2 className="text-lg font-semibold text-text truncate">
            {displayName}
          </h2>
          <p className="text-xs text-text-tertiary truncate">{account.email}</p>
        </div>
        <Button
          variant={saved ? "success" : "primary"}
          size="sm"
          icon={<Save />}
          loading={saving}
          onClick={handleSave}
        >
          {saved ? t("common.saved") : t("common.saveAll")}
        </Button>
      </div>

      <div ref={scrollRef} className="p-4 space-y-6 overflow-y-auto flex-1">
        <div>
          <h3 className="text-sm font-medium text-text mb-1">{t("settings.account.displayName")}</h3>
          <p className="text-xs text-text-tertiary mb-2">
            {t("settings.account.displayNameDesc")}
          </p>
          <input
            type="text"
            value={displayName}
            onChange={(e) => { setDisplayName(e.target.value); setSaved(false); }}
            className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm focus:border-accent"
          />
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1">
            <Palette className="w-4 h-4 text-text-tertiary" />
            <h3 className="text-sm font-medium text-text">{t("settings.account.accountColor")}</h3>
          </div>
          <p className="text-xs text-text-tertiary mb-3">
            {t("settings.account.accountColorDesc")}
          </p>
          <div className="flex gap-2 flex-wrap">
            {ACCOUNT_COLORS.map((c) => (
              <button
                key={c}
                onClick={() => { setColor(c); setSaved(false); }}
                className={`w-8 h-8 rounded-full transition-all ${
                  color === c ? "ring-2 ring-offset-2 ring-accent scale-110" : "hover:scale-105"
                }`}
                style={{ backgroundColor: c }}
                title={c}
              />
            ))}
          </div>
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1">
            <RefreshCw className="w-4 h-4 text-text-tertiary" />
            <h3 className="text-sm font-medium text-text">{t("settings.account.autoSync")}</h3>
          </div>
          <p className="text-xs text-text-tertiary mb-3">
            {t("settings.account.autoSyncDesc")}
          </p>
          <div className="grid grid-cols-3 gap-2">
            {SYNC_INTERVAL_OPTIONS.map((option) => (
              <button
                key={option.value}
                onClick={() => handleSyncIntervalChange(option.value)}
                className={`px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                  syncInterval === option.value
                    ? "border-accent bg-accent-soft text-accent"
                    : "border-border text-text-secondary hover:bg-hover"
                }`}
              >
                {t(option.labelKey)}
              </button>
            ))}
          </div>
          {syncInterval === 1 && (
            <p className="mt-2 text-xs text-warning">
              {t("settings.account.syncWarning1Min")}
            </p>
          )}
        </div>

        <div>
          <div className="flex items-center gap-2 mb-1">
            <Image className="w-4 h-4 text-text-tertiary" />
            <h3 className="text-sm font-medium text-text">{t("settings.account.loadExternalImages")}</h3>
          </div>
          <p className="text-xs text-text-tertiary mb-3">
            {t("settings.account.loadExternalImagesDesc")}
          </p>
          <div className="flex gap-2">
            <button
              onClick={() => { setLoadExternalImages("always"); setSaved(false); }}
              className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                loadExternalImages === "always"
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-text-secondary hover:bg-hover"
              }`}
            >
              {t("settings.account.loadImagesAlways")}
            </button>
            <button
              onClick={() => { setLoadExternalImages("never"); setSaved(false); }}
              className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                loadExternalImages === "never"
                  ? "border-accent bg-accent-soft text-accent"
                  : "border-border text-text-secondary hover:bg-hover"
              }`}
            >
              {t("settings.account.loadImagesNever")}
            </button>
          </div>
        </div>

        {!isOAuth && (
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Lock className="w-4 h-4 text-text-tertiary" />
              <h3 className="text-sm font-medium text-text">{t("settings.account.password")}</h3>
            </div>
            <p className="text-xs text-text-tertiary mb-3">
              {t("settings.account.passwordDesc")}
            </p>
            <div className="relative">
              <input
                type={showPassword ? "text" : "password"}
                value={password}
                onChange={(e) => { setPassword(e.target.value); setSaved(false); }}
                placeholder={t("settings.account.passwordPlaceholder")}
                className="w-full px-3 py-2 pr-10 rounded-lg border border-border bg-bg-secondary text-text text-sm font-mono focus:border-accent"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-text-tertiary hover:text-text"
              >
                {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
        )}

        {isOAuth && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-accent-soft border border-accent/20">
            <Info className="w-4 h-4 text-accent shrink-0 mt-0.5" />
            <p className="text-xs text-text-secondary">
              {t("settings.account.oauthHint")}
            </p>
          </div>
        )}

        <div>
          <div className="flex items-center gap-2 mb-1">
            <Server className="w-4 h-4 text-text-tertiary" />
            <h3 className="text-sm font-medium text-text">{t("settings.account.serverSettings")}</h3>
          </div>
          <p className="text-xs text-text-tertiary mb-3">
            {t("settings.account.serverSettingsDesc")}
          </p>
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr,80px] gap-2">
              <div>
                <label className="text-xs text-text-tertiary mb-1 block">{t("settings.account.imapServer")}</label>
                <input
                  type="text"
                  value={imapHost}
                  onChange={(e) => { setImapHost(e.target.value); setSaved(false); }}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm font-mono focus:border-accent"
                />
              </div>
              <div>
                <label className="text-xs text-text-tertiary mb-1 block">{t("settings.account.port")}</label>
                <input
                  type="number"
                  value={imapPort}
                  onChange={(e) => { setImapPort(parseInt(e.target.value) || 993); setSaved(false); }}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm font-mono focus:border-accent"
                />
              </div>
            </div>
            <div className="grid grid-cols-[1fr,80px] gap-2">
              <div>
                <label className="text-xs text-text-tertiary mb-1 block">{t("settings.account.smtpServer")}</label>
                <input
                  type="text"
                  value={smtpHost}
                  onChange={(e) => { setSmtpHost(e.target.value); setSaved(false); }}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm font-mono focus:border-accent"
                />
              </div>
              <div>
                <label className="text-xs text-text-tertiary mb-1 block">{t("settings.account.port")}</label>
                <input
                  type="number"
                  value={smtpPort}
                  onChange={(e) => { setSmtpPort(parseInt(e.target.value) || 587); setSaved(false); }}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm font-mono focus:border-accent"
                />
              </div>
            </div>
            <div>
              <label className="text-xs text-text-tertiary mb-1 block">{t("settings.account.smtpSecurity")}</label>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setSmtpSecurity("ssl");
                    if (smtpPort === 587) setSmtpPort(465);
                    setSaved(false);
                  }}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                    smtpSecurity === "ssl"
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border text-text-secondary hover:bg-hover"
                  }`}
                >
                  SSL/TLS (Port 465)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setSmtpSecurity("starttls");
                    if (smtpPort === 465) setSmtpPort(587);
                    setSaved(false);
                  }}
                  className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                    smtpSecurity === "starttls"
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border text-text-secondary hover:bg-hover"
                  }`}
                >
                  STARTTLS (Port 587)
                </button>
              </div>
            </div>
            <div className="p-2 rounded bg-bg-secondary">
              <span className="text-xs text-text-tertiary">{t("settings.account.provider")}: </span>
              <span className="text-xs text-text capitalize">{account.provider}</span>
            </div>
          </div>
        </div>

        <div>
          <h3 className="text-sm font-medium text-text mb-1">{t("settings.account.signature")}</h3>
          <p className="text-xs text-text-tertiary mb-3">
            {t("settings.account.signatureDesc")}
          </p>
          <SignatureEditor
            htmlValue={signatureHtml}
            textValue={signatureText}
            onChange={handleSignatureChange}
          />
          <div className="mt-4 space-y-2">
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={signatureOnCompose}
                onChange={(e) => { setSignatureOnCompose(e.target.checked); setSaved(false); }}
                className="w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0 bg-bg-secondary"
              />
              <span className="text-sm text-text">{t("settings.account.signatureOnCompose")}</span>
            </label>
            <label className="flex items-center gap-3 cursor-pointer">
              <input
                type="checkbox"
                checked={signatureOnReply}
                onChange={(e) => { setSignatureOnReply(e.target.checked); setSaved(false); }}
                className="w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0 bg-bg-secondary"
              />
              <span className="text-sm text-text">{t("settings.account.signatureOnReply")}</span>
            </label>
          </div>
        </div>
      </div>
    </>
  );
}

function InfoPanel() {
  const { t } = useTranslation();
  const { data: version = "" } = useQuery({
    queryKey: ["app-version"],
    queryFn: getVersion,
    staleTime: Infinity,
  });

  return (
    <div>
      <h3 className="text-sm font-medium text-text mb-1">{t("settings.info.title")}</h3>
      <p className="text-xs text-text-tertiary mb-4">{t("settings.info.description")}</p>

      <div className="space-y-3">
        <div className="flex items-center justify-between p-3 rounded-lg border border-border">
          <span className="text-sm text-text">{t("settings.info.version")}</span>
          <span className="text-sm font-mono text-text-secondary">{version}</span>
        </div>
        <div className="flex items-center justify-between p-3 rounded-lg border border-border">
          <span className="text-sm text-text">{t("settings.info.appName")}</span>
          <span className="text-sm text-text-secondary">Prudii Mail</span>
        </div>
        <div className="flex items-center justify-between p-3 rounded-lg border border-border">
          <span className="text-sm text-text">{t("settings.info.website")}</span>
          <a
            href="https://prudii.com"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-accent hover:underline"
          >
            prudii.com
          </a>
        </div>
      </div>
    </div>
  );
}

export function SettingsPanel() {
  const { t } = useTranslation();
  const scrollRef = useScroller<HTMLDivElement>();
  const { setShowSettings, setShowAccountWizard, themeMode, setThemeMode, setSelectedAccountId, setSelectedFolderId, setSelectedMailId, appSettings, setAppSettings, hasFeature } = useAppStore();
  const addToast = useAppStore((s) => s.addToast);
  const { data: accounts, refetch: refetchAccounts } = useAccounts();
  const deleteAccount = useDeleteAccount();
  const dialog = useDialog();
  const [view, setView] = useState<SettingsView>("main");
  const [activeTab, setActiveTabState] = useState<SettingsTab>(() => {
    const last = useAppStore.getState().settingsLastTab;
    return (SETTINGS_TABS.some((tab) => tab.id === last) ? last : "general") as SettingsTab;
  });

  function setActiveTab(tab: SettingsTab) {
    setActiveTabState(tab);
    useAppStore.getState().setSettingsLastTab(tab);
  }

  const [selectedAccount, setSelectedAccount] = useState<Account | null>(null);

  const [localSettings, setLocalSettings] = useState(appSettings);
  const [settingsSaved, setSettingsSaved] = useState(true);
  const [languagePref, setLanguagePref] = useState(getLanguagePreference());
  const [isDefaultMailApp, setIsDefaultMailApp] = useState(false);
  const accountDirtyRef = useRef(false);

  // Reset content scroll when switching tabs — otherwise a short tab can
  // render pre-scrolled after leaving a long one.
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [activeTab, view]);

  async function requestClose() {
    const dirty = !settingsSaved || accountDirtyRef.current;
    if (dirty) {
      const confirmed = await dialog.danger({
        title: t("settings.discardTitle"),
        message: t("settings.discardMessage"),
        confirmLabel: t("common.discard"),
        cancelLabel: t("common.cancel"),
      });
      if (!confirmed) return;
    }
    setShowSettings(false);
  }

  useEffect(() => {
    getAppSettings().then((s) => {
      setLocalSettings(s);
      setAppSettings(s);
      const lang = s.language as AppLanguage;
      setLanguagePref(lang);
      changeLanguage(lang);
    }).catch(console.error);
    isMailtoHandler().then(setIsDefaultMailApp).catch(() => {});
  }, []);

  // Esc closes the panel (guarded). No dependency array on purpose: the
  // listener re-binds every render so its closure always sees the current
  // dialog.isOpen / dirty state. Do not "optimize" with a deps array.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      // While the shared confirm dialog is open, Esc belongs to DialogProvider —
      // don't re-enter requestClose (stopPropagation can't stop sibling
      // document-level listeners, so we must bail explicitly).
      if (dialog.isOpen) return;
      if (e.key === "Escape") {
        requestClose();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  });

  async function handleSaveAppSettings() {
    try {
      const settingsToSave = { ...localSettings, language: languagePref };
      await updateAppSettings(settingsToSave);
      setAppSettings(settingsToSave);
      setSettingsSaved(true);
    } catch (err) {
      addToast("error", t("errors.settingsSave"), err instanceof Error ? err.message : String(err));
    }
  }

  function updateLocalSetting<K extends keyof typeof localSettings>(key: K, value: typeof localSettings[K]) {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
    setSettingsSaved(false);
  }

  function handleLanguageChange(lang: AppLanguage) {
    setLanguagePref(lang);
    changeLanguage(lang);
    setSettingsSaved(false);
  }

  function handleThemeChange(mode: ThemeMode) {
    setThemeMode(mode);
    // Persist against the last-committed baseline (appSettings), NOT the
    // localSettings working copy — pending unsaved edits must stay
    // discardable. Deliberately does not touch settingsSaved: the theme is
    // already saved the moment it is clicked.
    const persisted = { ...appSettings, theme_mode: mode };
    updateAppSettings(persisted)
      .then(() => setAppSettings(persisted))
      .catch(() => { /* localStorage still holds the value; next save catches up */ });
    setLocalSettings((prev) => ({ ...prev, theme_mode: mode }));
  }

  async function handleDelete(accountId: string) {
    const confirmed = await dialog.danger({
      title: t("settings.deleteAccountConfirm.title"),
      message: t("settings.deleteAccountConfirm.body"),
      confirmLabel: t("settings.deleteAccountConfirm.confirm"),
      cancelLabel: t("settings.deleteAccountConfirm.cancel"),
    });
    if (!confirmed) return;
    deleteAccount.mutate(accountId, {
      onSuccess: () => {
        // Immediately remove account from Zustand store so Sidebar updates
        const store = useAppStore.getState();
        store.setAccounts(store.accounts.filter((a) => a.id !== accountId));
        if (store.selectedAccountId === accountId) {
          setSelectedAccountId(null);
          setSelectedFolderId(null);
          setSelectedMailId(null);
        }
      },
    });
  }

  function handleAccountClick(account: Account) {
    setSelectedAccount(account);
    setView("account");
  }

  function handleBack() {
    setView("main");
    setSelectedAccount(null);
    // Refetch accounts to get updated signature
    refetchAccounts();
  }

  return (
    <div
      className="fixed inset-0 modal-backdrop flex items-center justify-center z-50"
      onClick={(e) => { if (e.target === e.currentTarget) requestClose(); }}
    >
      <div
        className="bg-surface rounded-xl w-full max-w-6xl mx-4 overflow-hidden h-[80vh] flex flex-col"
        style={{ boxShadow: "var(--shadow-lg)" }}
      >
        {view === "account" && selectedAccount ? (
          <AccountSettings account={selectedAccount} onBack={handleBack} dirtyRef={accountDirtyRef} />
        ) : (
          <>
            <div className="flex items-center justify-between p-4 border-b border-border shrink-0">
              <h2 className="text-lg font-semibold text-text">{t("settings.title")}</h2>
              <div className="flex items-center gap-2">
                {!settingsSaved && (
                  <Button size="sm" variant="primary" onClick={handleSaveAppSettings}>
                    {t("common.save")}
                  </Button>
                )}
                <IconButton
                  icon={<X />}
                  aria-label={t("common.close")}
                  onClick={requestClose}
                />
              </div>
            </div>

            <div className="flex border-b border-border px-4 shrink-0 overflow-x-auto scrollbar-none">
              {SETTINGS_TABS.map(({ id, labelKey, icon: Icon, premium }) => (
                <TabButton
                  key={id}
                  selected={activeTab === id}
                  onClick={() => setActiveTab(id)}
                  className="flex items-center gap-1.5 py-2.5 whitespace-nowrap"
                >
                  <Icon className="w-4 h-4" />
                  {t(labelKey)}
                  {premium && !hasFeature(id === "ai" ? "ai_replies" : id === "rules" ? "rules_filters" : "templates") && (
                    <PremiumBadge />
                  )}
                </TabButton>
              ))}
            </div>

            <div ref={scrollRef} className="p-4 space-y-6 overflow-y-auto flex-1">

              {activeTab === "general" && (
                <>
                  <div>
                    <h3 className="text-sm font-medium text-text mb-1">{t("settings.appearance.title")}</h3>
                    <p className="text-xs text-text-tertiary mb-3">
                      {t("settings.appearance.description")}
                    </p>
                    <div className="flex gap-2">
                      {THEME_OPTIONS.map(({ mode, labelKey, icon: Icon }) => (
                        <button
                          key={mode}
                          onClick={() => handleThemeChange(mode)}
                          className={`flex-1 flex flex-col items-center gap-2 p-3 rounded-lg border transition-colors ${
                            themeMode === mode
                              ? "border-accent bg-accent-soft text-accent"
                              : "border-border text-text-secondary hover:bg-hover"
                          }`}
                        >
                          <Icon className="w-5 h-5" />
                          <span className="text-xs font-medium">{t(labelKey)}</span>
                        </button>
                      ))}
                    </div>
                    <label className="mt-3 flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors cursor-pointer">
                      <PanelLeft className="w-4 h-4 text-text-tertiary shrink-0" />
                      <div className="flex-1">
                        <div className="text-sm text-text">{t(isMacOS ? "settings.appearance.transparentSidebar" : "settings.appearance.ambientSidebar")}</div>
                        <div className="text-xs text-text-tertiary">{t(isMacOS ? "settings.appearance.transparentSidebarDesc" : "settings.appearance.ambientSidebarDesc")}</div>
                      </div>
                      <input
                        type="checkbox"
                        checked={localSettings.transparent_sidebar}
                        onChange={(e) => updateLocalSetting("transparent_sidebar", e.target.checked)}
                        className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
                      />
                    </label>
                  </div>

                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Globe className="w-4 h-4 text-text-tertiary" />
                      <h3 className="text-sm font-medium text-text">{t("settings.language.title")}</h3>
                    </div>
                    <p className="text-xs text-text-tertiary mb-3">
                      {t("settings.language.description")}
                    </p>
                    <div className="flex gap-2">
                      {LANGUAGE_OPTIONS.map(({ value, labelKey }) => (
                        <button
                          key={value}
                          onClick={() => handleLanguageChange(value)}
                          className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                            languagePref === value
                              ? "border-accent bg-accent-soft text-accent"
                              : "border-border text-text-secondary hover:bg-hover"
                          }`}
                        >
                          {t(labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-medium text-text mb-1">{t("settings.appSettings.title")}</h3>
                    <p className="text-xs text-text-tertiary mb-3">
                      {t("settings.appSettings.description")}
                    </p>
                    <div className="space-y-3">
                      <label className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors cursor-pointer">
                        <Power className="w-4 h-4 text-text-tertiary shrink-0" />
                        <div className="flex-1">
                          <div className="text-sm text-text">{t("settings.appSettings.launchOnStartup")}</div>
                          <div className="text-xs text-text-tertiary">{t("settings.appSettings.launchOnStartupDesc")}</div>
                        </div>
                        <input
                          type="checkbox"
                          checked={localSettings.launch_on_startup}
                          onChange={(e) => updateLocalSetting("launch_on_startup", e.target.checked)}
                          className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
                        />
                      </label>

                      <label className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors cursor-pointer">
                        <AppWindow className="w-4 h-4 text-text-tertiary shrink-0" />
                        <div className="flex-1">
                          <div className="text-sm text-text">{t("settings.appSettings.showInTray")}</div>
                          <div className="text-xs text-text-tertiary">{t("settings.appSettings.showInTrayDesc")}</div>
                        </div>
                        <input
                          type="checkbox"
                          checked={localSettings.show_in_tray}
                          onChange={(e) => updateLocalSetting("show_in_tray", e.target.checked)}
                          className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
                        />
                      </label>

                      <label className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors cursor-pointer">
                        <Clock className="w-4 h-4 text-text-tertiary shrink-0" />
                        <div className="flex-1">
                          <div className="text-sm text-text">{t("settings.appSettings.use24hClock")}</div>
                          <div className="text-xs text-text-tertiary">{t("settings.appSettings.use24hClockDesc")}</div>
                        </div>
                        <input
                          type="checkbox"
                          checked={localSettings.use_24h_clock}
                          onChange={(e) => updateLocalSetting("use_24h_clock", e.target.checked)}
                          className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
                        />
                      </label>

                      <label className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors cursor-pointer">
                        <FolderOpen className="w-4 h-4 text-text-tertiary shrink-0" />
                        <div className="flex-1">
                          <div className="text-sm text-text">{t("settings.appSettings.showAllUnreadCounts")}</div>
                          <div className="text-xs text-text-tertiary">{t("settings.appSettings.showAllUnreadCountsDesc")}</div>
                        </div>
                        <input
                          type="checkbox"
                          checked={localSettings.show_all_unread_counts}
                          onChange={(e) => updateLocalSetting("show_all_unread_counts", e.target.checked)}
                          className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
                        />
                      </label>

                      <label className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors cursor-pointer">
                        <Bell className="w-4 h-4 text-text-tertiary shrink-0" />
                        <div className="flex-1">
                          <div className="text-sm text-text">{t("settings.appSettings.notifications")}</div>
                          <div className="text-xs text-text-tertiary">{t("settings.appSettings.notificationsDesc")}</div>
                        </div>
                        <input
                          type="checkbox"
                          checked={localSettings.notifications_enabled}
                          onChange={(e) => updateLocalSetting("notifications_enabled", e.target.checked)}
                          className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
                        />
                      </label>

                      <label className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors cursor-pointer">
                        <Volume2 className="w-4 h-4 text-text-tertiary shrink-0" />
                        <div className="flex-1">
                          <div className="text-sm text-text">{t("settings.appSettings.notificationSound")}</div>
                          <div className="text-xs text-text-tertiary">{t("settings.appSettings.notificationSoundDesc")}</div>
                        </div>
                        <input
                          type="checkbox"
                          checked={localSettings.notification_sound}
                          onChange={(e) => updateLocalSetting("notification_sound", e.target.checked)}
                          className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
                        />
                      </label>

                      <label className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors cursor-pointer">
                        <Mail className="w-4 h-4 text-text-tertiary shrink-0" />
                        <div className="flex-1">
                          <div className="text-sm text-text">{t("settings.appSettings.defaultMailApp")}</div>
                          <div className="text-xs text-text-tertiary">{t("settings.appSettings.defaultMailAppDesc")}</div>
                        </div>
                        <input
                          type="checkbox"
                          checked={isDefaultMailApp}
                          onChange={async (e) => {
                            const wantChecked = e.target.checked;
                            try {
                              if (wantChecked) {
                                await registerMailtoHandler();
                              } else {
                                await unregisterMailtoHandler();
                              }
                              setIsDefaultMailApp(wantChecked);
                            } catch (err) {
                              addToast("error", t("settings.mailtoFailed"), err instanceof Error ? err.message : String(err));
                              // Re-read actual OS state so the checkbox reflects reality.
                              isMailtoHandler().then(setIsDefaultMailApp).catch(() => {});
                            }
                          }}
                          className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
                        />
                      </label>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Send className="w-4 h-4 text-text-tertiary" />
                      <h3 className="text-sm font-medium text-text">{t("settings.undoSendDelay")}</h3>
                      {!hasFeature("undo_send_config") && <PremiumBadge />}
                    </div>
                    <p className="text-xs text-text-tertiary mb-3">
                      {t("settings.undoSendDelayDesc")}
                    </p>
                    <div className="flex gap-2">
                      {UNDO_SEND_OPTIONS.map((option) => (
                        <button
                          key={option.value}
                          onClick={() => {
                            if (hasFeature("undo_send_config") || option.value === 5) {
                              updateLocalSetting("undo_send_delay", option.value);
                            }
                          }}
                          disabled={!hasFeature("undo_send_config") && option.value !== 5}
                          className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                            localSettings.undo_send_delay === option.value
                              ? "border-accent bg-accent-soft text-accent"
                              : !hasFeature("undo_send_config") && option.value !== 5
                              ? "border-border text-text-tertiary opacity-50 cursor-not-allowed"
                              : "border-border text-text-secondary hover:bg-hover"
                          }`}
                        >
                          {"labelKey" in option ? t(option.labelKey as string) : option.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center gap-2 mb-1">
                      <Palette className="w-4 h-4 text-text-tertiary" />
                      <h3 className="text-sm font-medium text-text">{t("settings.accentColor.title")}</h3>
                    </div>
                    <p className="text-xs text-text-tertiary mb-3">
                      {t("settings.accentColor.description")}
                    </p>
                    <div className="flex gap-2 flex-wrap">
                      {ACCENT_COLORS.map(({ id, color, label }) => (
                        <button
                          key={id}
                          onClick={() => updateLocalSetting("accent_color", id)}
                          className="w-8 h-8 rounded-full transition-all hover:scale-110"
                          style={{
                            backgroundColor: color,
                            outline: localSettings.accent_color === id ? `2px solid ${color}` : "none",
                            outlineOffset: "3px",
                          }}
                          title={label}
                        />
                      ))}
                    </div>
                  </div>

                  <div>
                    <h3 className="text-sm font-medium text-text mb-1">{t("settings.density.title")}</h3>
                    <p className="text-xs text-text-tertiary mb-3">
                      {t("settings.density.description")}
                    </p>
                    <div className="flex gap-2">
                      {DENSITY_OPTIONS.map(({ id, labelKey }) => (
                        <button
                          key={id}
                          onClick={() => updateLocalSetting("density", id)}
                          className={`flex-1 px-3 py-2 rounded-lg border text-xs font-medium transition-colors ${
                            localSettings.density === id
                              ? "border-accent bg-accent-soft text-accent"
                              : "border-border text-text-secondary hover:bg-hover"
                          }`}
                        >
                          {t(labelKey)}
                        </button>
                      ))}
                    </div>
                  </div>
                </>
              )}

              {activeTab === "privacy" && (
                <PrivacySettings
                  localSettings={localSettings}
                  updateLocalSetting={updateLocalSetting}
                />
              )}

              {activeTab === "accounts" && (
                <div>
                  <div className="flex items-center justify-between mb-1">
                    <h3 className="text-sm font-medium text-text">{t("settings.accounts.title")}</h3>
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Plus className="w-3.5 h-3.5" />}
                      onClick={async () => {
                        // Guarded: pending edits must not be lost silently.
                        await requestClose();
                        // Only open the wizard if the panel actually closed.
                        if (!useAppStore.getState().showSettings) {
                          setShowAccountWizard(true);
                        }
                      }}
                    >
                      {t("sidebar.addAccount")}
                    </Button>
                  </div>
                  <p className="text-xs text-text-tertiary mb-3">
                    {t("settings.accounts.description")}
                  </p>
                  {accounts && accounts.length > 0 ? (
                    <div className="space-y-2">
                      {accounts.map((account) => (
                        <div
                          key={account.id}
                          className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors cursor-pointer"
                          onClick={() => handleAccountClick(account)}
                        >
                          <span
                            className="w-3 h-3 rounded-full shrink-0"
                            style={{ backgroundColor: account.color }}
                          />
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-medium text-text truncate">
                              {account.display_name}
                            </div>
                            <div className="text-xs text-text-tertiary truncate">
                              {account.email}
                            </div>
                          </div>

                          <div className="flex items-center gap-1 shrink-0">
                            <IconButton
                              icon={<Trash2 />}
                              aria-label={t("settings.accounts.removeAccount")}
                              className="hover:text-danger"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDelete(account.id);
                              }}
                            />
                            <ChevronRight className="w-4 h-4 text-text-tertiary" />
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <p className="text-sm text-text-tertiary">{t("settings.accounts.noAccounts")}</p>
                  )}
                </div>
              )}

              {activeTab === "rules" && (
                hasFeature("rules_filters") ? (
                  <RulesPanel />
                ) : (
                  <div className="text-center py-12">
                    <Lock className="w-8 h-8 text-text-tertiary mx-auto mb-3" />
                    <h3 className="text-sm font-medium text-text mb-1">{t("premium.upgradePrompt")}</h3>
                    <p className="text-xs text-text-tertiary mb-4">{t("rules.premiumDesc")}</p>
                    <Button variant="primary" size="sm" onClick={() => window.open("https://prudii.com/pricing", "_blank")}>
                      {t("premium.upgradeButton")}
                    </Button>
                  </div>
                )
              )}

              {activeTab === "templates" && (
                hasFeature("templates") ? (
                  <TemplatesPanel />
                ) : (
                  <div className="text-center py-12">
                    <Lock className="w-8 h-8 text-text-tertiary mx-auto mb-3" />
                    <h3 className="text-sm font-medium text-text mb-1">{t("premium.upgradePrompt")}</h3>
                    <p className="text-xs text-text-tertiary mb-4">{t("templates.premiumDesc")}</p>
                    <Button variant="primary" size="sm" onClick={() => window.open("https://prudii.com/pricing", "_blank")}>
                      {t("premium.upgradeButton")}
                    </Button>
                  </div>
                )
              )}

              {activeTab === "backup" && (
                <BackupRestore />
              )}

              {activeTab === "ai" && (
                hasFeature("ai_replies") ? (
                  <AiSettings
                    localSettings={localSettings}
                    updateLocalSetting={updateLocalSetting}
                  />
                ) : (
                  <div className="text-center py-12">
                    <Lock className="w-8 h-8 text-text-tertiary mx-auto mb-3" />
                    <h3 className="text-sm font-medium text-text mb-1">{t("premium.upgradePrompt")}</h3>
                    <p className="text-xs text-text-tertiary mb-4">{t("settings.ai.premiumDesc")}</p>
                    <Button variant="primary" size="sm" onClick={() => window.open("https://prudii.com/pricing", "_blank")}>
                      {t("premium.upgradeButton")}
                    </Button>
                  </div>
                )
              )}

              {activeTab === "license" && (
                <LicenseSettings />
              )}

              {activeTab === "update" && (
                <UpdatePanel />
              )}

              {activeTab === "info" && (
                <InfoPanel />
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
