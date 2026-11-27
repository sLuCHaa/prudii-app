import { useId } from "react";
import { useTranslation } from "react-i18next";
import { clampDeleteDays, describePop3Rule, type Pop3Rule } from "../../lib/pop3";
import type { Pop3DeleteMode } from "../../types";
import { Switch } from "../ui/Switch";

const MODES: { value: Pop3DeleteMode; labelKey: string }[] = [
  { value: "keep", labelKey: "pop3.mode.keep" },
  { value: "after_fetch", labelKey: "pop3.mode.afterFetch" },
  { value: "after_days", labelKey: "pop3.mode.afterDays" },
];

interface Pop3DeleteRuleProps {
  rule: Pop3Rule;
  onChange: (rule: Pop3Rule) => void;
}

export function Pop3DeleteRule({ rule, onChange }: Pop3DeleteRuleProps) {
  const { t } = useTranslation();
  const id = useId();
  const daysId = `${id}-days`;
  const withLocalId = `${id}-with-local`;

  return (
    <div className="space-y-2">
      <span className="block text-sm font-medium text-text-secondary">{t("pop3.ruleTitle")}</span>
      <p className="text-sm text-text">
        {describePop3Rule(t, { ...rule, days: clampDeleteDays(rule.days) })}
      </p>
      <div className="flex flex-col gap-2">
        {MODES.map((mode) => (
          <button
            key={mode.value}
            type="button"
            aria-pressed={rule.mode === mode.value}
            onClick={() => onChange({ ...rule, mode: mode.value })}
            className="option-tile px-3 py-2 rounded-control text-xs"
          >
            {t(mode.labelKey)}
          </button>
        ))}
      </div>
      {rule.mode === "after_days" && (
        <div>
          <label htmlFor={daysId} className="block text-sm font-medium text-text-secondary mb-1">
            {t("pop3.days")}
          </label>
          {/* NaN stands for an emptied field until blur */}
          <input
            id={daysId}
            type="number"
            min={1}
            max={365}
            value={Number.isNaN(rule.days) ? "" : rule.days}
            onChange={(e) => onChange({ ...rule, days: e.target.value === "" ? NaN : Number(e.target.value) })}
            onBlur={() => onChange({ ...rule, days: clampDeleteDays(rule.days) })}
            className="w-28 px-3 py-2 rounded-control inset-shadow-field border border-border bg-surface text-text focus:border-accent"
          />
        </div>
      )}
      <div className="flex items-center justify-between gap-3">
        <span id={withLocalId} className="text-sm text-text-secondary">
          {t("pop3.withLocal")}
        </span>
        <Switch
          checked={rule.withLocal}
          onChange={(withLocal) => onChange({ ...rule, withLocal })}
          aria-labelledby={withLocalId}
          className="shrink-0"
        />
      </div>
      {(rule.mode !== "keep" || rule.withLocal) && (
        <p className="text-xs text-text-tertiary">{t("pop3.rule.localOnly")}</p>
      )}
    </div>
  );
}
