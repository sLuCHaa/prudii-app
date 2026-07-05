import { useEffect } from "react";
import { Sparkles, Loader2, CheckCircle, XCircle, ExternalLink, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { checkOllamaStatus } from "../../lib/tauri";
import { Button } from "../ui/Button";
import type { AppSettings } from "../../types";

interface AiSettingsProps {
  localSettings: AppSettings;
  updateLocalSetting: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) => void;
}

function useOllamaErrorTranslator() {
  const { t } = useTranslation();
  return (error: string | null | undefined): string => {
    if (!error) return t("settings.ai.connectionFailed");
    if (error === "OLLAMA_NOT_RUNNING") return t("settings.ai.ollamaNotRunning");
    if (error === "OLLAMA_TIMEOUT") return t("settings.ai.ollamaTimeout");
    if (error.includes("OLLAMA_NOT_RUNNING")) return t("settings.ai.ollamaNotRunning");
    return error;
  };
}

export function AiSettings({ localSettings, updateLocalSetting }: AiSettingsProps) {
  const { t } = useTranslation();
  const translateOllamaError = useOllamaErrorTranslator();

  // Cached for 60 s so flipping between tabs doesn't refire the HTTP test;
  // the manual button below always calls refetch() (live).
  // The backend tests the SAVED Ollama URL from app_settings, so the key must
  // NOT vary with the text input — a per-keystroke key would refire the test
  // on every character while testing nothing new. After editing the URL the
  // user saves and/or presses the Test button (refetch is always live).
  const ollamaQuery = useQuery({
    queryKey: ["ollama-status"],
    queryFn: checkOllamaStatus,
    enabled: localSettings.ai_enabled,
    staleTime: 60_000,
    retry: false,
  });

  const testing = ollamaQuery.isFetching;
  const status = ollamaQuery.data;
  const models = status?.connected ? status.models : [];
  const connectionStatus: "idle" | "connected" | "error" =
    testing || !localSettings.ai_enabled
      ? "idle"
      : status
        ? (status.connected ? "connected" : "error")
        : ollamaQuery.isError
          ? "error"
          : "idle";
  const connectionError: string | null =
    connectionStatus !== "error"
      ? null
      : status && !status.connected
        ? translateOllamaError(status.error)
        : translateOllamaError(ollamaQuery.error instanceof Error ? ollamaQuery.error.message : String(ollamaQuery.error ?? ""));

  // Auto-select the first model once a successful test reports models.
  useEffect(() => {
    if (status?.connected && !localSettings.ai_model && status.models.length > 0) {
      updateLocalSetting("ai_model", status.models[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  function handleTestConnection() {
    ollamaQuery.refetch();
  }

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-2 mb-1">
          <Sparkles className="w-4 h-4 text-text-tertiary" />
          <h3 className="text-sm font-medium text-text">{t("settings.ai.title")}</h3>
        </div>
        <p className="text-xs text-text-tertiary mb-4">
          {t("settings.ai.description")}
        </p>

        <label className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors cursor-pointer mb-4">
          <Sparkles className="w-4 h-4 text-text-tertiary shrink-0" />
          <div className="flex-1">
            <div className="text-sm text-text">{t("settings.ai.enable")}</div>
            <div className="text-xs text-text-tertiary">{t("settings.ai.ollamaRequired")}</div>
          </div>
          <input
            type="checkbox"
            checked={localSettings.ai_enabled}
            onChange={(e) => updateLocalSetting("ai_enabled", e.target.checked)}
            className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
          />
        </label>

        {localSettings.ai_enabled && (
          <div className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                {t("settings.ai.ollamaUrl")}
              </label>
              <input
                type="text"
                value={localSettings.ollama_url}
                onChange={(e) => updateLocalSetting("ollama_url", e.target.value)}
                placeholder="http://localhost:11434"
                className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm font-mono focus:border-accent"
              />
            </div>

            <div className="flex items-center gap-3">
              <Button
                variant="secondary"
                size="sm"
                loading={testing}
                onClick={handleTestConnection}
              >
                {t("settings.ai.testConnection")}
              </Button>

              {connectionStatus === "connected" && (
                <div className="flex items-center gap-1.5 text-success text-xs">
                  <CheckCircle className="w-4 h-4" />
                  <span>{t("settings.ai.connected")}</span>
                </div>
              )}
              {connectionStatus === "error" && (
                <div className="flex items-center gap-1.5 text-danger text-xs">
                  <XCircle className="w-4 h-4" />
                  <span>{connectionError || t("settings.ai.notConnected")}</span>
                </div>
              )}
            </div>

            <div>
              <label className="block text-xs font-medium text-text-secondary mb-1.5">
                {t("settings.ai.model")}
              </label>
              {models.length > 0 ? (
                <select
                  value={localSettings.ai_model}
                  onChange={(e) => updateLocalSetting("ai_model", e.target.value)}
                  className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm focus:border-accent cursor-pointer"
                >
                  <option value="" className="bg-surface text-text">
                    {t("settings.ai.selectModel")}
                  </option>
                  {models.map((m) => (
                    <option key={m} value={m} className="bg-surface text-text">
                      {m}
                    </option>
                  ))}
                </select>
              ) : (
                <div className="px-3 py-2 rounded-lg border border-border bg-bg-secondary text-xs text-text-tertiary">
                  {connectionStatus === "connected"
                    ? t("settings.ai.noModels")
                    : t("settings.ai.testFirst")}
                </div>
              )}
            </div>

            <div className="p-3 rounded-lg bg-bg-secondary border border-border-light text-xs text-text-tertiary space-y-2.5">
              <div className="flex items-center gap-1.5">
                <Info className="w-3.5 h-3.5 text-accent shrink-0" />
                <span className="font-semibold text-text-secondary">{t("settings.ai.recommendedModels")}</span>
              </div>
              <p>{t("settings.ai.recommendationDesc")}</p>
              <table className="w-full text-left">
                <tbody className="divide-y divide-border-light">
                  <tr>
                    <td className="py-1.5 pr-3 font-mono text-text-secondary whitespace-nowrap">1B – 3B</td>
                    <td className="py-1.5 pr-3 text-text-tertiary">~2–4 GB RAM</td>
                    <td className="py-1.5">{t("settings.ai.modelRecSmall")}</td>
                  </tr>
                  <tr className="bg-accent/5">
                    <td className="py-1.5 pr-3 font-mono text-accent font-semibold whitespace-nowrap">7B – 8B</td>
                    <td className="py-1.5 pr-3 text-text-tertiary">~5–8 GB RAM</td>
                    <td className="py-1.5 text-accent">{t("settings.ai.modelRecMedium")}</td>
                  </tr>
                  <tr>
                    <td className="py-1.5 pr-3 font-mono text-text-secondary whitespace-nowrap">13B+</td>
                    <td className="py-1.5 pr-3 text-text-tertiary">~16+ GB RAM</td>
                    <td className="py-1.5">{t("settings.ai.modelRecLarge")}</td>
                  </tr>
                </tbody>
              </table>
              <p className="text-[11px] leading-relaxed">
                {t("settings.ai.quickStart")}
              </p>
            </div>

            <div className="p-3 rounded-lg bg-bg-secondary border border-border-light text-xs text-text-tertiary">
              <p className="mb-1">{t("settings.ai.ollamaRequired")}</p>
              <a
                href="https://ollama.com"
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-accent hover:underline"
              >
                ollama.com
                <ExternalLink className="w-3 h-3" />
              </a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
