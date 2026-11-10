import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { Edit3 } from "../icons";
import { listSignatures } from "../../lib/tauri";
import { useAccounts } from "../../hooks/useAccounts";
import { Button } from "../ui/Button";
import { Switch } from "../ui/Switch";
import { SettingsBlock, SettingsRow } from "./SettingsGroup";
import { SignaturePreview } from "./SignaturePreview";

interface AccountSignatureSectionProps {
  accountId: string;
  signatureId: string | null;
  onSignatureChange: (id: string | null) => void;
  onCompose: boolean;
  onReply: boolean;
  onComposeChange: (value: boolean) => void;
  onReplyChange: (value: boolean) => void;
  onEdit: (signatureId: string) => void;
}

/** The account's side of the signature list: pick one, see it, and say when it is added. */
export function AccountSignatureSection({
  accountId,
  signatureId,
  onSignatureChange,
  onCompose,
  onReply,
  onComposeChange,
  onReplyChange,
  onEdit,
}: AccountSignatureSectionProps) {
  const { t } = useTranslation();
  const { data: signatures = [] } = useQuery({ queryKey: ["signatures"], queryFn: listSignatures });
  const { data: accounts = [] } = useAccounts();

  const chosen = signatures.find((s) => s.id === signatureId) ?? null;
  const others = chosen
    ? accounts.filter((a) => a.id !== accountId && a.signature_id === chosen.id).map((a) => a.display_name)
    : [];

  return (
    <>
      <SettingsBlock description={t("settings.account.signatureDesc")}>
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="flex-[1_1_260px] min-w-0">
              <label htmlFor="account-signature" className="text-xs text-text-tertiary mb-1 block">
                {t("settings.account.signatureSelect")}
              </label>
              <select
                id="account-signature"
                value={chosen?.id ?? ""}
                onChange={(e) => onSignatureChange(e.target.value || null)}
                className="w-full px-3 py-2 rounded-control inset-shadow-field border border-border bg-bg-secondary text-text text-sm focus:border-accent"
              >
                <option value="">{t("settings.account.signatureNone")}</option>
                {signatures.map((signature) => (
                  <option key={signature.id} value={signature.id}>
                    {signature.name}
                  </option>
                ))}
              </select>
            </div>
            {chosen && (
              <Button variant="secondary" size="sm" icon={<Edit3 />} onClick={() => onEdit(chosen.id)}>
                {t("settings.account.signatureEditInTab")}
              </Button>
            )}
          </div>
          {chosen && <SignaturePreview html={chosen.html} text={chosen.text} />}
          {others.length > 0 && (
            <p data-signature-shared className="text-xs text-text-tertiary">
              {t("settings.account.signatureSharedWith", { accounts: others.join(", ") })}
            </p>
          )}
        </div>
      </SettingsBlock>
      <SettingsRow
        title={t("settings.account.signatureOnCompose")}
        control={<Switch checked={onCompose} onChange={onComposeChange} />}
      />
      <SettingsRow
        title={t("settings.account.signatureOnReply")}
        control={<Switch checked={onReply} onChange={onReplyChange} />}
      />
    </>
  );
}
