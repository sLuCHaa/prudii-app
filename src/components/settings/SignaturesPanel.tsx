import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, Plus, Trash2 } from "../icons";
import { deleteSignature, duplicateSignature, listSignatures, saveSignature } from "../../lib/tauri";
import { draftOf, isDraftDirty, usesOther, type SignatureDraft } from "../../lib/signatures";
import { useAccounts } from "../../hooks/useAccounts";
import { useAppStore } from "../../stores/appStore";
import { Button } from "../ui/Button";
import { useDialog } from "../ui/DialogProvider";
import { SettingsBlock, SettingsGroup } from "./SettingsGroup";
import { SignatureEditor } from "./SignatureEditor";
import type { Account, Signature } from "../../types";

export interface SignaturesPanelProps {
  initialSignatureId: string | null;
  onDirtyChange: (dirty: boolean) => void;
  /** The settings header saves through this; it resolves false when the save was refused or failed. */
  saveRef: React.MutableRefObject<(() => Promise<boolean>) | null>;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

export function SignaturesPanel({ initialSignatureId, onDirtyChange, saveRef }: SignaturesPanelProps) {
  const { t } = useTranslation();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);
  const { data: signatures } = useQuery({ queryKey: ["signatures"], queryFn: listSignatures });
  const { data: accounts } = useAccounts();

  const [draft, setDraft] = useState<SignatureDraft | null>(null);
  const [nameMissing, setNameMissing] = useState(false);
  const [busy, setBusy] = useState(false);

  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !signatures || !accounts) return;
    opened.current = true;
    const first = signatures.find((s) => s.id === initialSignatureId) ?? signatures[0];
    setDraft(first ? draftOf(first, accounts) : null);
  }, [signatures, accounts, initialSignatureId]);

  const stored = draft?.id ? (signatures?.find((s) => s.id === draft.id) ?? null) : null;
  const dirty = draft !== null && isDraftDirty(draft, stored, accounts ?? []);

  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);

  const refresh = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["signatures"] }),
      queryClient.invalidateQueries({ queryKey: ["accounts"] }),
    ]);
    return {
      signatures: queryClient.getQueryData<Signature[]>(["signatures"]) ?? [],
      accounts: queryClient.getQueryData<Account[]>(["accounts"]) ?? [],
    };
  }, [queryClient]);

  const save = useCallback(async (): Promise<boolean> => {
    if (!draft) return true;
    const name = draft.name.trim();
    if (!name) {
      setNameMissing(true);
      return false;
    }
    setBusy(true);
    try {
      const saved = await saveSignature({ ...draft, name });
      const fresh = await refresh();
      setDraft(draftOf(saved, fresh.accounts));
      return true;
    } catch (err) {
      addToast("error", t("signatures.saveFailed"), message(err));
      return false;
    } finally {
      setBusy(false);
    }
  }, [draft, refresh, addToast, t]);

  useEffect(() => {
    saveRef.current = save;
  }, [save, saveRef]);

  useEffect(
    () => () => {
      saveRef.current = null;
      onDirtyChange(false);
    },
    [saveRef, onDirtyChange],
  );

  async function open(signature: Signature | null) {
    if (dirty) {
      const discard = await dialog.danger({
        title: t("settings.discardTitle"),
        message: t("settings.discardMessage"),
        confirmLabel: t("common.discard"),
        cancelLabel: t("common.cancel"),
      });
      if (!discard) return;
    }
    setNameMissing(false);
    setDraft(draftOf(signature, accounts ?? []));
  }

  async function handleDuplicate() {
    if (!stored || dirty) return;
    setBusy(true);
    try {
      const copy = await duplicateSignature(stored.id, t("signatures.copyName", { name: stored.name }));
      const fresh = await refresh();
      setDraft(draftOf(copy, fresh.accounts));
    } catch (err) {
      addToast("error", t("signatures.duplicateFailed"), message(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete() {
    if (!stored) return;
    const users = (accounts ?? []).filter((a) => a.signature_id === stored.id).map((a) => a.display_name);
    const confirmed = await dialog.danger({
      title: t("signatures.delete"),
      message:
        users.length > 0
          ? t("signatures.deleteConfirmUsed", { name: stored.name, accounts: users.join(", ") })
          : t("signatures.deleteConfirm", { name: stored.name }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await deleteSignature(stored.id);
      const fresh = await refresh();
      setNameMissing(false);
      setDraft(fresh.signatures[0] ? draftOf(fresh.signatures[0], fresh.accounts) : null);
    } catch (err) {
      addToast("error", t("signatures.deleteFailed"), message(err));
    } finally {
      setBusy(false);
    }
  }

  function toggleAccount(accountId: string, ticked: boolean) {
    setDraft((d) => d && { ...d, accountIds: ticked ? [...d.accountIds, accountId] : d.accountIds.filter((id) => id !== accountId) });
  }

  if (!signatures || !accounts) return null;

  return (
    <div className="flex flex-wrap items-start gap-4">
      <div className="flex-[1_1_260px] min-w-0 space-y-2">
        <SettingsGroup title={t("signatures.title")}>
          <SettingsBlock description={t("signatures.description")} />
          {signatures.length === 0 && (
            <SettingsBlock>
              <p className="text-sm text-text-tertiary">{t("signatures.empty")}</p>
            </SettingsBlock>
          )}
          {signatures.map((signature) => {
            const users = accounts.filter((a) => a.signature_id === signature.id);
            const selected = draft?.id === signature.id;
            return (
              <button
                key={signature.id}
                type="button"
                data-signature-row
                aria-pressed={selected}
                onClick={() => { if (!selected) void open(signature); }}
                className={`flex w-full flex-col items-start gap-1.5 px-3 py-2.5 text-left transition-colors ${selected ? "bg-selected" : "hover:bg-hover"}`}
              >
                <span className="text-sm font-medium text-text truncate max-w-full">{signature.name}</span>
                {users.length > 0 ? (
                  <span className="flex flex-wrap gap-x-3 gap-y-1">
                    {users.map((account) => (
                      <span key={account.id} className="inline-flex items-center gap-1.5 text-xs text-text-secondary">
                        <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: account.color }} />
                        {account.display_name}
                      </span>
                    ))}
                  </span>
                ) : (
                  <span className="text-xs text-text-tertiary">{t("signatures.unassigned")}</span>
                )}
              </button>
            );
          })}
        </SettingsGroup>
        <Button variant="secondary" size="sm" fullWidth icon={<Plus />} onClick={() => void open(null)}>
          {t("signatures.new")}
        </Button>
      </div>

      {draft && (
        <div className="flex-[999_1_480px] min-w-0 space-y-5">
          <SettingsGroup
            title={t(draft.id ? "signatures.edit" : "signatures.new")}
            action={
              draft.id && (
                <div className="flex gap-1.5">
                  <Button variant="secondary" size="sm" icon={<Copy />} disabled={dirty || busy} onClick={() => void handleDuplicate()}>
                    {t("signatures.duplicate")}
                  </Button>
                  <Button variant="secondary" size="sm" icon={<Trash2 />} disabled={busy} onClick={() => void handleDelete()}>
                    {t("common.delete")}
                  </Button>
                </div>
              )
            }
          >
            <SettingsBlock>
              <label htmlFor="signature-name" className="text-xs text-text-tertiary mb-1 block">
                {t("signatures.name")}
              </label>
              <input
                id="signature-name"
                type="text"
                value={draft.name}
                onChange={(e) => {
                  const name = e.target.value;
                  setNameMissing(false);
                  setDraft((d) => d && { ...d, name });
                }}
                aria-invalid={nameMissing}
                className="w-full px-3 py-2 rounded-control inset-shadow-field border border-border bg-bg-secondary text-text text-sm focus:border-accent"
              />
              {nameMissing && <p className="mt-1.5 text-xs text-danger">{t("signatures.nameRequired")}</p>}
            </SettingsBlock>
            <SettingsBlock>
              <SignatureEditor
                key={draft.id ?? "new"}
                htmlValue={draft.html}
                textValue={draft.text}
                onChange={(html, text) => setDraft((d) => d && { ...d, html, text })}
              />
            </SettingsBlock>
          </SettingsGroup>

          <SettingsGroup title={t("signatures.usedBy")}>
            <SettingsBlock description={t("signatures.usedByDesc")} />
            {accounts.map((account) => {
              const other = usesOther(account, draft.id, signatures);
              return (
                <label key={account.id} className="settings-row">
                  <input
                    type="checkbox"
                    checked={draft.accountIds.includes(account.id)}
                    onChange={(e) => toggleAccount(account.id, e.target.checked)}
                    className="w-4 h-4 shrink-0 accent-accent"
                  />
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: account.color }} />
                  <div className="settings-row-text">
                    <div className="settings-row-title truncate">{account.display_name}</div>
                    <div className="settings-row-desc truncate">{account.email}</div>
                  </div>
                  {other && <span className="text-xs text-text-tertiary shrink-0">{t("signatures.usesOther", { name: other })}</span>}
                </label>
              );
            })}
          </SettingsGroup>
        </div>
      )}
    </div>
  );
}
