import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueries } from "@tanstack/react-query";
import { ChevronRight, FolderDown } from "lucide-react";
import { Button } from "../ui/Button";
import { useDialog } from "../ui/DialogProvider";
import { useAppStore } from "../../stores/appStore";
import { useAccounts } from "../../hooks/useAccounts";
import { listFolders, startMailExport } from "../../lib/tauri";
import { buildExportLabels, defaultFolderIds } from "../../lib/mailExport";
import { SettingsGroup, SettingsBlock } from "./SettingsGroup";

const CHECKBOX = "w-4 h-4 rounded border-border text-accent focus:ring-accent focus:ring-offset-0 bg-bg-secondary";

export function MailExportSection() {
  const { t, i18n } = useTranslation();
  const dialog = useDialog();
  const running = useAppStore((s) => s.mailExport.running);
  const { data: accounts = [] } = useAccounts();
  const [preselect] = useState(() => useAppStore.getState().mailExportPreselect);
  const [accountOff, setAccountOff] = useState<Record<string, boolean>>({});
  const [folderOverride, setFolderOverride] = useState<Record<string, boolean>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [html, setHtml] = useState(true);
  const [eml, setEml] = useState(true);
  const [includeAttachments, setIncludeAttachments] = useState(true);

  useEffect(() => {
    if (preselect) useAppStore.setState({ mailExportPreselect: null });
  }, [preselect]);

  const folderQueries = useQueries({
    queries: accounts.map((a) => ({ queryKey: ["folders", a.id], queryFn: () => listFolders(a.id) })),
  });

  const isAccountOn = (id: string) => accountOff[id] ?? (preselect ? id === preselect : true);

  function selectedFolderIds(): string[] {
    const ids: string[] = [];
    accounts.forEach((account, i) => {
      if (!isAccountOn(account.id)) return;
      const folders = folderQueries[i]?.data ?? [];
      const defaults = new Set(defaultFolderIds(folders));
      for (const f of folders) if (folderOverride[f.id] ?? defaults.has(f.id)) ids.push(f.id);
    });
    return ids;
  }

  async function showError(key: string) {
    await dialog.alert({ title: t("mailExport.title"), message: t(key, { defaultValue: key }) });
  }

  async function handleExport() {
    const folderIds = selectedFolderIds();
    if (!html && !eml) return showError("mailExport.errors.noFormat");
    if (folderIds.length === 0) return showError("mailExport.errors.noSelection");
    try {
      await startMailExport(
        { folderIds, html, eml, includeAttachments },
        buildExportLabels(t, i18n.language),
      );
    } catch (err) {
      await showError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <SettingsGroup title={t("mailExport.title")} icon={<FolderDown className="w-4 h-4" />}>
      <SettingsBlock description={t("mailExport.description")} className="space-y-3">
        <div className="space-y-1">
          {accounts.map((account, i) => {
            const folders = folderQueries[i]?.data ?? [];
            const defaults = new Set(defaultFolderIds(folders));
            const on = isAccountOn(account.id);
            const open = expanded[account.id] === true;
            return (
              <div key={account.id}>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => setExpanded((s) => ({ ...s, [account.id]: !open }))}
                    aria-expanded={open}
                    className="p-1 rounded-md hover:bg-hover text-text-tertiary"
                  >
                    <ChevronRight className={`w-3 h-3 transition-transform duration-200 ${open ? "rotate-90" : ""}`} />
                  </button>
                  <label className="flex items-center gap-3 p-2 rounded-lg hover:bg-hover transition-colors cursor-pointer flex-1 min-w-0">
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => setAccountOff((s) => ({ ...s, [account.id]: on }))}
                      className={CHECKBOX}
                    />
                    <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: account.color }} />
                    <span className="text-sm text-text truncate">{account.email}</span>
                  </label>
                </div>
                {open && (
                  <div className="ml-9 space-y-0.5">
                    {folders.map((f) => (
                      <label key={f.id} className="flex items-center gap-3 px-2 py-1 rounded-lg hover:bg-hover transition-colors cursor-pointer">
                        <input
                          type="checkbox"
                          checked={folderOverride[f.id] ?? defaults.has(f.id)}
                          disabled={!on}
                          onChange={(e) => setFolderOverride((s) => ({ ...s, [f.id]: e.target.checked }))}
                          className={CHECKBOX}
                        />
                        <span className="text-sm text-text-secondary truncate">
                          {t(`folder.types.${f.folder_type}`, { defaultValue: f.name })}
                        </span>
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        <div className="space-y-1.5">
          <label className="flex items-center gap-3 p-2 rounded-lg hover:bg-hover transition-colors cursor-pointer">
            <input type="checkbox" checked={html} onChange={() => setHtml(!html)} className={CHECKBOX} />
            <span className="text-sm text-text">{t("mailExport.formatHtml")}</span>
          </label>
          <label className="flex items-center gap-3 p-2 rounded-lg hover:bg-hover transition-colors cursor-pointer">
            <input type="checkbox" checked={eml} onChange={() => setEml(!eml)} className={CHECKBOX} />
            <span className="text-sm text-text">{t("mailExport.formatEml")}</span>
          </label>
          <div>
            <label className="flex items-center gap-3 p-2 rounded-lg hover:bg-hover transition-colors cursor-pointer">
              <input type="checkbox" checked={includeAttachments} onChange={() => setIncludeAttachments(!includeAttachments)} className={CHECKBOX} />
              <span className="text-sm text-text">{t("mailExport.attachments")}</span>
            </label>
            <p className="ml-9 text-xs text-text-tertiary">{t("mailExport.attachmentsHint")}</p>
          </div>
        </div>

        <Button variant="primary" size="sm" disabled={running} onClick={() => { void handleExport(); }}>
          {t("mailExport.exportButton")}
        </Button>
      </SettingsBlock>
    </SettingsGroup>
  );
}
