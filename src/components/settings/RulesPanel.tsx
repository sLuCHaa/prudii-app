import { useState } from "react";
import { Plus, Trash2, ChevronDown, ChevronUp } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { useAccounts, useRules, useCreateRule, useUpdateRule, useDeleteRule, useFolders, useApplyRulesNow } from "../../hooks/useAccounts";
import { Button } from "../ui/Button";
import type { MailRule, CreateRuleRequest } from "../../types";

function emptyRule(accountId: string): CreateRuleRequest {
  return {
    account_id: accountId,
    name: "",
    enabled: true,
    priority: 0,
    from_contains: null,
    to_contains: null,
    subject_contains: null,
    has_attachments: null,
    action_move_to_folder: null,
    action_mark_read: null,
    action_star: null,
    action_trash: null,
    action_archive: null,
  };
}

function RuleForm({
  rule,
  accountId,
  onSave,
  onCancel,
  saving,
}: {
  rule: CreateRuleRequest | MailRule;
  accountId: string;
  onSave: (rule: CreateRuleRequest | MailRule) => void;
  onCancel: () => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const { data: folders } = useFolders(accountId);
  const [form, setForm] = useState({ ...rule });

  function handleSave() {
    if (!form.name.trim()) return;
    onSave(form);
  }

  return (
    <div className="space-y-4 p-4 rounded-lg border border-border bg-bg-secondary">
      <div className="grid grid-cols-[1fr,100px] gap-3">
        <div>
          <label className="text-xs text-text-tertiary mb-1 block">{t("rules.name")}</label>
          <input
            type="text"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder={t("rules.namePlaceholder")}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text text-sm focus:border-accent"
          />
        </div>
        <div>
          <label className="text-xs text-text-tertiary mb-1 block">{t("rules.priority")}</label>
          <input
            type="number"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: parseInt(e.target.value) || 0 })}
            className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text text-sm focus:border-accent"
          />
        </div>
      </div>

      <div>
        <h4 className="text-xs font-medium text-text mb-1">{t("rules.conditions")}</h4>
        <p className="text-xs text-text-tertiary mb-2">{t("rules.conditionsDesc")}</p>
        <div className="space-y-2">
          <div>
            <label className="text-xs text-text-tertiary mb-1 block">{t("rules.fromContains")}</label>
            <input
              type="text"
              value={form.from_contains ?? ""}
              onChange={(e) => setForm({ ...form, from_contains: e.target.value || null })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text text-sm focus:border-accent"
            />
          </div>
          <div>
            <label className="text-xs text-text-tertiary mb-1 block">{t("rules.toContains")}</label>
            <input
              type="text"
              value={form.to_contains ?? ""}
              onChange={(e) => setForm({ ...form, to_contains: e.target.value || null })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text text-sm focus:border-accent"
            />
          </div>
          <div>
            <label className="text-xs text-text-tertiary mb-1 block">{t("rules.subjectContains")}</label>
            <input
              type="text"
              value={form.subject_contains ?? ""}
              onChange={(e) => setForm({ ...form, subject_contains: e.target.value || null })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text text-sm focus:border-accent"
            />
          </div>
          <div>
            <label className="text-xs text-text-tertiary mb-1 block">{t("rules.attachmentsLabel")}</label>
            <div className="flex gap-1">
              {([
                { val: null, label: t("rules.attachmentsAny") },
                { val: true, label: t("rules.attachmentsWith") },
                { val: false, label: t("rules.attachmentsWithout") },
              ] as { val: boolean | null; label: string }[]).map((opt) => (
                <button
                  key={String(opt.val)}
                  type="button"
                  onClick={() => setForm({ ...form, has_attachments: opt.val })}
                  className={`flex-1 px-2 py-1.5 rounded-lg border text-xs font-medium transition-colors ${
                    form.has_attachments === opt.val
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border bg-surface text-text-secondary hover:bg-hover"
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div>
        <h4 className="text-xs font-medium text-text mb-1">{t("rules.actions")}</h4>
        <p className="text-xs text-text-tertiary mb-2">{t("rules.actionsDesc")}</p>
        <div className="space-y-2">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.action_mark_read === true}
              onChange={(e) => setForm({ ...form, action_mark_read: e.target.checked ? true : null })}
              className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
            />
            <span className="text-sm text-text">{t("rules.markRead")}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.action_star === true}
              onChange={(e) => setForm({ ...form, action_star: e.target.checked ? true : null })}
              className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
            />
            <span className="text-sm text-text">{t("rules.star")}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.action_trash === true}
              onChange={(e) => setForm({ ...form, action_trash: e.target.checked ? true : null })}
              className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
            />
            <span className="text-sm text-text">{t("rules.trash")}</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.action_archive === true}
              onChange={(e) => setForm({ ...form, action_archive: e.target.checked ? true : null })}
              className="w-4 h-4 rounded border-border text-accent focus:ring-accent"
            />
            <span className="text-sm text-text">{t("rules.archive")}</span>
          </label>
          <div>
            <label className="text-xs text-text-tertiary mb-1 block">{t("rules.moveToFolder")}</label>
            <select
              value={form.action_move_to_folder ?? ""}
              onChange={(e) => setForm({ ...form, action_move_to_folder: e.target.value || null })}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text text-sm focus:border-accent"
            >
              <option value="">{t("rules.selectFolder")}</option>
              {folders?.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="secondary" size="sm" onClick={onCancel}>
          {t("common.cancel")}
        </Button>
        <Button variant="primary" size="sm" onClick={handleSave} loading={saving} disabled={!form.name.trim()}>
          {t("rules.save")}
        </Button>
      </div>
    </div>
  );
}

export function RulesPanel() {
  const { t } = useTranslation();
  const addToast = useAppStore((s) => s.addToast);
  const { data: accounts } = useAccounts();
  const [selectedAccountId, setSelectedAccountId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [editingRule, setEditingRule] = useState<MailRule | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const accountId = selectedAccountId ?? accounts?.[0]?.id ?? null;

  const { data: rules } = useRules(accountId);
  const createRuleMutation = useCreateRule();
  const updateRuleMutation = useUpdateRule();
  const deleteRuleMutation = useDeleteRule();
  const applyRulesMutation = useApplyRulesNow();
  const [confirmApply, setConfirmApply] = useState(false);
  const [applyResult, setApplyResult] = useState<number | null>(null);

  function handleApplyNow() {
    if (!accountId) return;
    applyRulesMutation.mutate(accountId, {
      onSuccess: (count) => {
        setConfirmApply(false);
        setApplyResult(count);
      },
      onError: () => {
        setConfirmApply(false);
      },
    });
  }

  function handleCreate(rule: CreateRuleRequest | MailRule) {
    createRuleMutation.mutate(rule as CreateRuleRequest, {
      onSuccess: () => setShowForm(false),
      onError: (err) => addToast("error", t("rules.saveFailed"), err instanceof Error ? err.message : String(err)),
    });
  }

  function handleUpdate(rule: CreateRuleRequest | MailRule) {
    updateRuleMutation.mutate(rule as MailRule, {
      onSuccess: () => setEditingRule(null),
      onError: (err) => addToast("error", t("rules.saveFailed"), err instanceof Error ? err.message : String(err)),
    });
  }

  function handleToggleEnabled(rule: MailRule) {
    updateRuleMutation.mutate({ ...rule, enabled: !rule.enabled }, {
      onError: (err) => addToast("error", t("rules.saveFailed"), err instanceof Error ? err.message : String(err)),
    });
  }

  function handleDelete(ruleId: string) {
    if (!accountId) return;
    deleteRuleMutation.mutate(
      { ruleId, accountId },
      {
        onSuccess: () => setConfirmDeleteId(null),
        onError: (err) => addToast("error", t("rules.deleteFailed"), err instanceof Error ? err.message : String(err)),
      }
    );
  }

  return (
    <div>
      <h3 className="text-sm font-medium text-text mb-1">{t("rules.title")}</h3>
      <p className="text-xs text-text-tertiary mb-3">{t("rules.description")}</p>

      {accounts && accounts.length > 1 && (
        <div className="mb-4">
          <label className="text-xs text-text-tertiary mb-1 block">{t("rules.selectAccount")}</label>
          <select
            value={accountId ?? ""}
            onChange={(e) => {
              setSelectedAccountId(e.target.value);
              setShowForm(false);
              setEditingRule(null);
              setConfirmApply(false);
              setApplyResult(null);
            }}
            className="w-full px-3 py-2 rounded-lg border border-border bg-bg-secondary text-text text-sm focus:border-accent"
          >
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.display_name} ({a.email})
              </option>
            ))}
          </select>
        </div>
      )}

      {accountId && (
        <>
          {rules && rules.length > 0 ? (
            <div className="space-y-2 mb-4">
              {rules.map((rule) =>
                editingRule?.id === rule.id ? (
                  <RuleForm
                    key={rule.id}
                    rule={editingRule}
                    accountId={accountId}
                    onSave={handleUpdate}
                    onCancel={() => setEditingRule(null)}
                    saving={updateRuleMutation.isPending}
                  />
                ) : (
                  <div
                    key={rule.id}
                    className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={rule.enabled}
                      onChange={() => handleToggleEnabled(rule)}
                      className="w-4 h-4 rounded border-border text-accent focus:ring-accent shrink-0"
                      title={t("rules.enabled")}
                    />

                    <div
                      className="flex-1 min-w-0 cursor-pointer"
                      onClick={() => setEditingRule(rule)}
                    >
                      <div className="text-sm font-medium text-text truncate">
                        {rule.name}
                      </div>
                      <div className="text-xs text-text-tertiary truncate">
                        {[
                          rule.from_contains && `${t("rules.fromContains")}: ${rule.from_contains}`,
                          rule.to_contains && `${t("rules.toContains")}: ${rule.to_contains}`,
                          rule.subject_contains && `${t("rules.subjectContains")}: ${rule.subject_contains}`,
                          rule.has_attachments === true
                            ? t("rules.attachmentsWith")
                            : rule.has_attachments === false
                            ? t("rules.attachmentsWithout")
                            : null,
                        ]
                          .filter(Boolean)
                          .join(" · ") || "—"}
                      </div>
                    </div>

                    {rule.priority !== 0 && (
                      <span className="text-xs text-text-tertiary bg-bg-secondary px-1.5 py-0.5 rounded shrink-0">
                        P{rule.priority}
                      </span>
                    )}

                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => setEditingRule(rule)}
                        className="p-1 rounded hover:bg-hover text-text-tertiary hover:text-text transition-colors"
                      >
                        {editingRule?.id === rule.id ? (
                          <ChevronUp className="w-4 h-4" />
                        ) : (
                          <ChevronDown className="w-4 h-4" />
                        )}
                      </button>
                      {confirmDeleteId === rule.id ? (
                        <div className="flex items-center gap-1">
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setConfirmDeleteId(null)}
                          >
                            {t("common.cancel")}
                          </Button>
                          <Button
                            variant="danger"
                            size="sm"
                            loading={deleteRuleMutation.isPending}
                            onClick={() => handleDelete(rule.id)}
                          >
                            {t("common.delete")}
                          </Button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(rule.id)}
                          className="p-1 rounded hover:bg-hover text-text-tertiary hover:text-danger transition-colors"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </div>
                )
              )}
            </div>
          ) : (
            <p className="text-sm text-text-tertiary mb-4">{t("rules.noRules")}</p>
          )}

          {showForm ? (
            <RuleForm
              rule={emptyRule(accountId)}
              accountId={accountId}
              onSave={handleCreate}
              onCancel={() => setShowForm(false)}
              saving={createRuleMutation.isPending}
            />
          ) : (
            <Button
              variant="secondary"
              size="sm"
              icon={<Plus className="w-4 h-4" />}
              onClick={() => setShowForm(true)}
            >
              {t("rules.addRule")}
            </Button>
          )}
          {rules && rules.length > 0 && (
            <div className="mt-4 pt-4 border-t border-border">
              {confirmApply ? (
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-xs text-text-secondary">{t("rules.applyNowConfirm")}</span>
                  <Button variant="secondary" size="sm" onClick={() => setConfirmApply(false)}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    loading={applyRulesMutation.isPending}
                    onClick={handleApplyNow}
                  >
                    {t("rules.applyNow")}
                  </Button>
                </div>
              ) : (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    setApplyResult(null);
                    setConfirmApply(true);
                  }}
                >
                  {t("rules.applyNow")}
                </Button>
              )}
              {applyResult !== null && (
                <p className="text-xs text-text-tertiary mt-2">
                  {t("rules.applyNowResult", { count: applyResult })}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
