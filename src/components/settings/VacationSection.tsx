import { useEffect, useState } from "react";
import { Plane, Info } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppStore } from "../../stores/appStore";
import { checkSieveSupport, getVacation, setVacation } from "../../lib/tauri";
import { Button } from "../ui/Button";
import { DateField } from "../ui/DateField";
import { SegmentedControl } from "../ui/SegmentedControl";
import { SettingsGroup, SettingsBlock } from "./SettingsGroup";
import type { VacationSettings, VacationState } from "../../types";

const INPUT = "w-full px-3 py-2 rounded-control inset-shadow-field border border-border bg-bg-secondary text-text text-sm focus:border-accent";

function toDraft(state: VacationState): VacationSettings {
  return { enabled: state.enabled, from: state.from, until: state.until, subject: state.subject, text: state.text };
}

/// Empty fields mean "not set" to the server, never an empty string.
function normalize(d: VacationSettings): VacationSettings {
  return {
    enabled: d.enabled,
    from: d.from || null,
    until: d.until || null,
    subject: d.subject?.trim() || null,
    text: d.text,
  };
}

function same(a: VacationSettings, b: VacationSettings) {
  const x = normalize(a);
  const y = normalize(b);
  return x.enabled === y.enabled && x.from === y.from && x.until === y.until && x.subject === y.subject && x.text === y.text;
}

export function VacationSection({ accountId }: { accountId: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const addToast = useAppStore((s) => s.addToast);

  const supportQuery = useQuery({
    queryKey: ["sieve-support", accountId],
    queryFn: () => checkSieveSupport(accountId),
    staleTime: 5 * 60 * 1000,
  });
  const supported = supportQuery.data?.status === "supported";
  const stateQuery = useQuery({
    queryKey: ["vacation", accountId],
    queryFn: () => getVacation(accountId),
    enabled: supported,
  });
  const state = stateQuery.data;

  const [draft, setDraft] = useState<VacationSettings | null>(null);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (state) setDraft(toDraft(state));
  }, [state]);

  function patch(p: Partial<VacationSettings>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }

  async function save() {
    if (!draft) return;
    setSaving(true);
    try {
      await setVacation(accountId, normalize(draft));
      addToast("success", t("settings.account.vacation.saved"));
      await queryClient.invalidateQueries({ queryKey: ["vacation", accountId] });
    } catch (err) {
      addToast("error", t("settings.account.vacation.saveFailed"), err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  let body: React.ReactNode;
  if (supportQuery.isPending) {
    body = <Hint>{t("settings.account.vacation.checking")}</Hint>;
  } else if (supportQuery.isError || supportQuery.data.status === "unreachable") {
    body = <Hint>{t("settings.account.vacation.unreachable")}</Hint>;
  } else if (supportQuery.data.status === "unsupported") {
    body = <Hint>{t("settings.account.vacation.unsupported")}</Hint>;
  } else if (stateQuery.isError) {
    body = <Hint>{t("settings.account.vacation.loadFailed")}</Hint>;
  } else if (!state || !draft) {
    body = <Hint>{t("settings.account.vacation.checking")}</Hint>;
  } else if (state.source === "locked") {
    body = <Hint>{t("settings.account.vacation.locked")}</Hint>;
  } else {
    const dirty = !same(draft, toDraft(state));
    const incomplete = draft.enabled && draft.text.trim() === "";
    body = (
      <div className="space-y-3">
        {state.source === "foreign" && (
          <Hint>
            {t("settings.account.vacation.foreign")}
            {state.had_addresses && ` ${t("settings.account.vacation.foreignAddresses")}`}
          </Hint>
        )}
        <SegmentedControl
          aria-label={t("settings.account.vacation.title")}
          value={draft.enabled ? "on" : "off"}
          onChange={(v) => patch({ enabled: v === "on" })}
          options={[
            { value: "off", label: t("settings.account.vacation.off") },
            { value: "on", label: t("settings.account.vacation.on") },
          ]}
        />
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="text-xs text-text-tertiary mb-1 block">{t("settings.account.vacation.from")}</label>
            <DateField value={draft.from ?? ""} onChange={(from) => patch({ from })} clearable ariaLabel={t("settings.account.vacation.from")} />
          </div>
          <div>
            <label className="text-xs text-text-tertiary mb-1 block">{t("settings.account.vacation.until")}</label>
            <DateField value={draft.until ?? ""} min={draft.from ?? undefined} onChange={(until) => patch({ until })} clearable ariaLabel={t("settings.account.vacation.until")} />
          </div>
        </div>
        <p className="text-xs text-text-tertiary">{t("settings.account.vacation.serverTime")}</p>
        <div>
          <label className="text-xs text-text-tertiary mb-1 block">{t("settings.account.vacation.subject")}</label>
          <input
            type="text"
            value={draft.subject ?? ""}
            onChange={(e) => patch({ subject: e.target.value })}
            placeholder={t("settings.account.vacation.subjectPlaceholder")}
            className={INPUT}
          />
        </div>
        <div>
          <label className="text-xs text-text-tertiary mb-1 block">{t("settings.account.vacation.text")}</label>
          <textarea
            rows={5}
            value={draft.text}
            onChange={(e) => patch({ text: e.target.value })}
            placeholder={t("settings.account.vacation.textPlaceholder")}
            className={`${INPUT} resize-y`}
          />
        </div>
        {draft.enabled && !state.enabled && (
          <div className="flex items-start gap-2 p-3 rounded-lg bg-warning/10">
            <Info className="w-4 h-4 text-warning shrink-0 mt-0.5" />
            <p className="text-xs text-text-secondary">{t("settings.account.vacation.panelWarning")}</p>
          </div>
        )}
        <div className="flex justify-end">
          <Button size="sm" onClick={save} loading={saving} disabled={saving || !dirty || incomplete}>
            {t("settings.account.vacation.save")}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <SettingsGroup title={t("settings.account.vacation.title")} icon={<Plane className="w-4 h-4" />}>
      <SettingsBlock description={t("settings.account.vacation.desc")}>
        {body}
      </SettingsBlock>
    </SettingsGroup>
  );
}

function Hint({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-text-secondary">{children}</p>;
}
