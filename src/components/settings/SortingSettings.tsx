import { useCallback, useEffect, useState } from "react";
import { Tags } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { deleteSenderCategory, listSenderCategories, resetCategories } from "../../lib/tauri";
import { runCategorization } from "../../hooks/useCategories";
import { BUILTIN_CATEGORIES, CATEGORY_COLORS, isCategoryId } from "../../lib/categories";
import { useAppStore } from "../../stores/appStore";
import { useDialog } from "../ui/DialogProvider";
import { Switch } from "../ui/Switch";
import { Button } from "../ui/Button";
import { SettingsGroup, SettingsBlock, SettingsRow } from "./SettingsGroup";
import type { AppSettings, SenderRule } from "../../types";

interface SortingSettingsProps {
  localSettings: AppSettings;
  updateLocalSetting: <K extends keyof AppSettings>(
    key: K,
    value: AppSettings[K]
  ) => void;
}

export function SortingSettings({ localSettings, updateLocalSetting }: SortingSettingsProps) {
  const { t } = useTranslation();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);
  const [senders, setSenders] = useState<SenderRule[]>([]);
  const hidden = localSettings.hidden_categories;

  const loadSenders = useCallback(() => {
    listSenderCategories().then(setSenders).catch(() => setSenders([]));
  }, []);

  useEffect(() => {
    loadSenders();
  }, [loadSenders]);

  const toggleCategory = (id: string, visible: boolean) => {
    updateLocalSetting(
      "hidden_categories",
      visible ? hidden.filter((c) => c !== id) : [...hidden.filter((c) => c !== id), id],
    );
  };

  const reportError = (err: unknown) =>
    addToast("error", t("errors.generic"), err instanceof Error ? err.message : String(err));

  const removeSender = async (email: string) => {
    try {
      await deleteSenderCategory(email);
      loadSenders();
      await runCategorization(queryClient);
    } catch (err) {
      reportError(err);
    }
  };

  const reset = async () => {
    const ok = await dialog.danger({
      title: t("categories.settings.resetConfirmTitle"),
      message: t("categories.settings.resetDesc"),
      confirmLabel: t("categories.settings.resetButton"),
    });
    if (!ok) return;
    try {
      await resetCategories();
      loadSenders();
      addToast("success", t("categories.settings.resetDone"));
      await runCategorization(queryClient);
    } catch (err) {
      reportError(err);
    }
  };

  return (
    <>
      <SettingsGroup title={t("categories.settings.title")} icon={<Tags className="w-4 h-4" />}>
        <SettingsRow
          title={t("categories.settings.enable")}
          description={t("categories.settings.enableDesc")}
          control={
            <Switch
              checked={localSettings.sorting_enabled}
              onChange={(v) => updateLocalSetting("sorting_enabled", v)}
            />
          }
        />
      </SettingsGroup>

      {localSettings.sorting_enabled && (
        <>
          <SettingsGroup title={t("categories.settings.visibleTitle")}>
            <SettingsBlock description={t("categories.settings.visibleDesc")} />
            {BUILTIN_CATEGORIES.map((id) => (
              <SettingsRow
                key={id}
                icon={
                  <span
                    className="w-2.5 h-2.5 rounded-full shrink-0"
                    style={{ backgroundColor: CATEGORY_COLORS[id] }}
                  />
                }
                title={t(`categories.names.${id}`)}
                control={<Switch checked={!hidden.includes(id)} onChange={(v) => toggleCategory(id, v)} />}
              />
            ))}
          </SettingsGroup>

          <SettingsGroup title={t("categories.settings.sendersTitle")}>
            {senders.length === 0 ? (
              <SettingsBlock description={t("categories.settings.sendersEmpty")} />
            ) : (
              senders.map((s) => (
                <SettingsRow
                  key={s.email}
                  as="div"
                  title={s.email}
                  description={isCategoryId(s.category) ? t(`categories.names.${s.category}`) : t("categories.none")}
                  control={
                    <Button variant="secondary" size="sm" onClick={() => removeSender(s.email)}>
                      {t("categories.settings.removeSender")}
                    </Button>
                  }
                />
              ))
            )}
          </SettingsGroup>

          <SettingsGroup title={t("categories.settings.resetTitle")}>
            <SettingsBlock description={t("categories.settings.resetDesc")}>
              <Button variant="danger" size="sm" onClick={reset}>
                {t("categories.settings.resetButton")}
              </Button>
            </SettingsBlock>
          </SettingsGroup>
        </>
      )}
    </>
  );
}
