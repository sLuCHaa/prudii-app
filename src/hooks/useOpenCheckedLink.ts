import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useDialog } from "../components/ui/DialogProvider";
import { checkLink } from "../lib/linkChecker";
import { cleanMailUrl } from "../lib/trackingParams";

/** Opens a web link in the browser, asking first when the link checker finds it suspicious. */
export function useOpenCheckedLink() {
  const dialog = useDialog();
  const { t } = useTranslation();
  return useCallback((href: string) => {
    const cleaned = cleanMailUrl(href);
    const result = checkLink(cleaned);
    if (result.safe) {
      openUrl(cleaned).catch(() => {});
      return;
    }
    const warningLines = result.warnings.map((w) => `• ${t(`linkCheck.${w.type}`)}: ${w.detail}`).join("\n");
    dialog.danger({
      title: t("linkCheck.suspiciousLink"),
      message: `${t("linkCheck.warningMessage")}\n\n${warningLines}\n\n${cleaned}`,
      confirmLabel: t("linkCheck.openAnyway"),
    }).then((confirmed) => {
      if (confirmed) openUrl(cleaned).catch(() => {});
    });
  }, [dialog, t]);
}
