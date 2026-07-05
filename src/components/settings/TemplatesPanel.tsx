import { useState } from "react";
import { Plus, Trash2, Edit3, X, Save } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { listTemplates, createTemplate, updateTemplate, deleteTemplate } from "../../lib/tauri";
import { Button } from "../ui/Button";
import { useDialog } from "../ui/DialogProvider";
import { useAppStore } from "../../stores/appStore";
import { escapeHtml } from "../../lib/sanitize";
import type { EmailTemplate } from "../../types";

export function TemplatesPanel() {
  const { t } = useTranslation();
  const dialog = useDialog();
  const addToast = useAppStore((s) => s.addToast);
  const queryClient = useQueryClient();
  const { data: templates = [] } = useQuery({
    queryKey: ["templates"],
    queryFn: listTemplates,
    staleTime: 300_000,
  });
  const [editing, setEditing] = useState<EmailTemplate | null>(null);
  const [isNew, setIsNew] = useState(false);

  const [name, setName] = useState("");
  const [subject, setSubject] = useState("");
  const [bodyText, setBodyText] = useState("");
  const [saving, setSaving] = useState(false);

  function handleNew() {
    setEditing(null);
    setIsNew(true);
    setName("");
    setSubject("");
    setBodyText("");
  }

  function handleEdit(tpl: EmailTemplate) {
    setEditing(tpl);
    setIsNew(false);
    setName(tpl.name);
    setSubject(tpl.subject);
    setBodyText(tpl.body_text);
  }

  function handleCancel() {
    setEditing(null);
    setIsNew(false);
  }

  async function handleSave() {
    if (!name.trim()) return;
    setSaving(true);
    try {
      // Escape before wrapping in HTML — raw "<" / "&" in the template text
      // would otherwise be parsed as markup when inserted into the editor.
      const bodyHtml = `<p>${escapeHtml(bodyText).replace(/\n/g, "<br>")}</p>`;
      if (isNew) {
        await createTemplate(name.trim(), subject.trim(), bodyHtml, bodyText);
      } else if (editing) {
        await updateTemplate(editing.id, name.trim(), subject.trim(), bodyHtml, bodyText);
      }
      await queryClient.invalidateQueries({ queryKey: ["templates"] });
      setEditing(null);
      setIsNew(false);
    } catch (err) {
      addToast("error", t("templates.saveFailed"), err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(tpl: EmailTemplate) {
    const confirmed = await dialog.danger({
      title: t("templates.deleteTemplate"),
      message: t("templates.deleteConfirmMessage", { name: tpl.name }),
      confirmLabel: t("common.delete"),
      cancelLabel: t("common.cancel"),
    });
    if (!confirmed) return;

    try {
      await deleteTemplate(tpl.id);
      await queryClient.invalidateQueries({ queryKey: ["templates"] });
      if (editing?.id === tpl.id) {
        setEditing(null);
        setIsNew(false);
      }
    } catch (err) {
      addToast("error", t("templates.deleteFailed"), err instanceof Error ? err.message : String(err));
    }
  }

  const showForm = isNew || editing !== null;

  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <h3 className="text-sm font-medium text-text">{t("templates.title")}</h3>
        {!showForm && (
          <Button variant="secondary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={handleNew}>
            {t("templates.newTemplate")}
          </Button>
        )}
      </div>
      <p className="text-xs text-text-tertiary mb-4">{t("templates.description")}</p>

      {showForm && (
        <div className="mb-4 p-4 rounded-lg border border-border bg-bg-secondary space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-medium text-text">
              {isNew ? t("templates.newTemplate") : t("templates.editTemplate")}
            </h4>
            <button onClick={handleCancel} className="p-1 rounded hover:bg-hover text-text-tertiary">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">{t("templates.templateName")}</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("templates.templateName")}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text text-sm focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">{t("compose.subject")}</label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder={t("compose.subjectPlaceholder")}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text text-sm focus:border-accent"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-text-secondary mb-1">{t("templates.body")}</label>
            <textarea
              value={bodyText}
              onChange={(e) => setBodyText(e.target.value)}
              rows={6}
              placeholder={t("compose.writeMessage")}
              className="w-full px-3 py-2 rounded-lg border border-border bg-surface text-text text-sm focus:border-accent resize-y"
            />
          </div>

          <div className="flex justify-end gap-2">
            <Button variant="secondary" size="sm" onClick={handleCancel}>
              {t("common.cancel")}
            </Button>
            <Button variant="primary" size="sm" icon={<Save className="w-3.5 h-3.5" />} loading={saving} disabled={!name.trim()} onClick={handleSave}>
              {t("common.save")}
            </Button>
          </div>
        </div>
      )}

      {templates.length === 0 && !showForm ? (
        <div className="text-center py-8">
          <p className="text-sm text-text-tertiary mb-3">{t("templates.noTemplates")}</p>
          <Button variant="secondary" size="sm" icon={<Plus className="w-3.5 h-3.5" />} onClick={handleNew}>
            {t("templates.newTemplate")}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          {templates.map((tpl) => (
            <div
              key={tpl.id}
              className="flex items-center gap-3 p-3 rounded-lg border border-border hover:bg-hover transition-colors"
            >
              <div className="flex-1 min-w-0">
                <div className="text-sm font-medium text-text truncate">{tpl.name}</div>
                {tpl.subject && (
                  <div className="text-xs text-text-tertiary truncate">{tpl.subject}</div>
                )}
              </div>
              <button
                onClick={() => handleEdit(tpl)}
                className="p-1.5 rounded hover:bg-hover text-text-tertiary hover:text-text transition-colors"
              >
                <Edit3 className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleDelete(tpl)}
                className="p-1.5 rounded hover:bg-hover text-text-tertiary hover:text-danger transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
