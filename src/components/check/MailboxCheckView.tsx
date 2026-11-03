import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Loader2, Lock, Mail, MailMinus, Shield, ShieldAlert, UserMinus } from "../icons";
import { useAppStore } from "../../stores/appStore";
import { allowListAgain, blockSender, getNewsletterOverview, getTrackerReport, retryUnsubscribe, unsubscribeMail } from "../../lib/tauri";
import { runTrackerScan } from "../../lib/trackerScan";
import { checkState, companyBars, initials, readShare } from "../../lib/mailboxCheck";
import { invalidateMailListQueries } from "../../lib/mailQueries";
import { causeMessage } from "../../lib/errorToast";
import { useDialog } from "../ui/DialogProvider";
import { Select } from "../ui/Select";
import { EmptyState } from "../ui/EmptyState";
import { UnsubscribeDialog } from "../layout/UnsubscribeDialog";
import { ListStatusChip } from "../layout/ListStatusChip";
import type { NewsletterRow, TrackerReport, UnsubscribeOutcome } from "../../types";

const FIRST_ROWS = 20;
const ROW_GRID = "grid grid-cols-[minmax(0,2.4fr)_minmax(0,0.8fr)_minmax(0,1.3fr)_minmax(0,0.9fr)_minmax(0,1.6fr)] items-center gap-4";

function Tile({ icon, label, value, text, signal }: { icon: React.ReactNode; label: string; value: string; text: string; signal?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-bg p-4 flex flex-col gap-1.5">
      <div className="flex items-center gap-1.5 text-xs font-medium text-text-secondary">
        {icon}
        {label}
      </div>
      <div className={`text-3xl font-semibold tabular-nums ${signal ? "text-accent" : "text-text"}`}>{value}</div>
      <p className="text-sm text-text-secondary">{text}</p>
    </div>
  );
}

function ReadBar({ row }: { row: NewsletterRow }) {
  const { t } = useTranslation();
  const share = readShare(row);
  return (
    <div className="flex flex-col gap-1 min-w-0">
      <div className="h-1.5 rounded-full bg-bg-secondary overflow-hidden">
        <div className={`h-full rounded-full ${share >= 0.5 ? "bg-success" : "bg-accent"}`} style={{ width: `${Math.max(share * 100, row.read ? 3 : 0)}%` }} />
      </div>
      <span className="text-xs text-text-secondary truncate">{t("mailboxCheck.list.readOf", { read: row.read, count: row.count })}</span>
    </div>
  );
}

function TrackerPanel({ report }: { report: TrackerReport }) {
  const { t, i18n } = useTranslation();
  const bars = companyBars(report);
  const max = Math.max(1, ...bars.map((b) => b.count));
  const senders = report.senders.slice(0, 5);
  return (
    <section className="rounded-xl border border-border bg-bg p-5 flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-text">
          <ShieldAlert className="w-4 h-4 text-accent" />
          {t("mailboxCheck.trackers.title")}
        </h2>
        <p className="text-sm text-text-secondary leading-relaxed max-w-[65ch]">{t("mailboxCheck.trackers.explain")}</p>
      </div>
      {bars.length === 0 ? (
        <p className="text-sm text-text-tertiary">{t("mailboxCheck.trackers.none")}</p>
      ) : (
        <div className="grid gap-6 md:grid-cols-2">
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium uppercase tracking-wide text-text-tertiary">{t("mailboxCheck.trackers.byCompany")}</div>
            {bars.map((bar) => (
              <div key={bar.other ? "__other" : bar.label} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className={`truncate ${bar.other ? "text-text-secondary" : "text-text"}`}>{bar.other ? t("mailboxCheck.trackers.other") : bar.label}</span>
                  <span className="tabular-nums text-text-secondary">{bar.count.toLocaleString(i18n.language)}</span>
                </div>
                <div className="h-1.5 rounded-full bg-bg-secondary overflow-hidden">
                  <div className={`h-full rounded-full ${bar.other ? "bg-text-tertiary" : "bg-accent"}`} style={{ width: `${(bar.count / max) * 100}%` }} />
                </div>
              </div>
            ))}
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-xs font-medium uppercase tracking-wide text-text-tertiary">{t("mailboxCheck.trackers.bySender")}</div>
            {senders.map((sender) => (
              <div key={sender.address} className="flex items-center justify-between gap-3 text-sm">
                <span className="truncate text-text" title={sender.address}>{sender.name}</span>
                <span className="shrink-0 tabular-nums text-text-secondary">{t("mailboxCheck.list.trackerChip", { count: sender.count })}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <p className="text-xs text-text-tertiary">{t("mailboxCheck.trackers.footnote")}</p>
    </section>
  );
}

export function MailboxCheckView() {
  const { t, i18n } = useTranslation();
  const dialog = useDialog();
  const queryClient = useQueryClient();
  const accounts = useAppStore((s) => s.accounts);
  const addToast = useAppStore((s) => s.addToast);
  const [accountId, setAccountId] = useState("");
  const [scanning, setScanning] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pending, setPending] = useState<{ row: NewsletterRow; mode: "unsubscribe" | "block" } | null>(null);
  const account = accountId || undefined;

  const { data: overview } = useQuery({ queryKey: ["newsletter-overview", accountId], queryFn: () => getNewsletterOverview(account) });
  const { data: report } = useQuery({ queryKey: ["tracker-report", accountId], queryFn: () => getTrackerReport(account) });

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["newsletter-overview"] });
    queryClient.invalidateQueries({ queryKey: ["tracker-report"] });
    queryClient.invalidateQueries({ queryKey: ["list-status"] });
  }, [queryClient]);

  useEffect(() => {
    let alive = true;
    runTrackerScan()
      .catch(() => 0)
      .finally(() => {
        if (alive) setScanning(false);
        refresh();
      });
    return () => {
      alive = false;
    };
  }, [refresh]);

  const showError = useCallback((e: unknown) => {
    const raw = String(e);
    dialog.alert({ type: "danger", title: t("common.error"), message: raw.startsWith("unsubscribe.errors.") ? t(raw) : causeMessage(e) });
  }, [dialog, t]);

  const applyOutcome = useCallback((outcome: UnsubscribeOutcome) => {
    if (outcome.web_url) openUrl(outcome.web_url).catch(() => {});
    if (outcome.trashed > 0) {
      addToast("success", t("unsubscribe.movedToTrash", { count: outcome.trashed }));
      invalidateMailListQueries(queryClient);
    }
  }, [addToast, queryClient, t]);

  const confirmPending = useCallback(async (trashExisting: boolean) => {
    const current = pending;
    setPending(null);
    if (!current) return;
    setBusyKey(current.row.key);
    try {
      const run = current.mode === "block" ? blockSender : unsubscribeMail;
      applyOutcome(await run(current.row.sample_mail_id, trashExisting));
    } catch (e) {
      showError(e);
    } finally {
      setBusyKey(null);
      refresh();
    }
  }, [pending, applyOutcome, showError, refresh]);

  const listAction = useCallback(async (row: NewsletterRow, action: "retry" | "allow", id: string) => {
    if (action === "allow") {
      const confirmed = await dialog.confirm({
        title: t("unsubscribe.allowAgainTitle", { name: row.subscription?.display_name ?? row.name }),
        message: t("unsubscribe.allowAgainMessage"),
        confirmLabel: t("unsubscribe.allowAgain"),
      });
      if (!confirmed) return;
    }
    setBusyKey(row.key);
    try {
      if (action === "allow") await allowListAgain(id);
      else applyOutcome(await retryUnsubscribe(id));
    } catch (e) {
      showError(e);
    } finally {
      setBusyKey(null);
      refresh();
    }
  }, [dialog, t, applyOutcome, showError, refresh]);

  const accountOptions = useMemo(
    () => [{ value: "", label: t("mailboxCheck.allAccounts") }, ...accounts.map((a) => ({ value: a.id, label: a.email }))],
    [accounts, t],
  );

  const state = checkState(overview, report, scanning);
  const rows = overview ? (showAll ? overview.rows : overview.rows.slice(0, FIRST_ROWS)) : [];
  const num = (n: number) => n.toLocaleString(i18n.language);

  return (
    <div className="flex flex-col h-full bg-surface">
      <div className="px-6 py-3 border-b border-border flex items-center gap-4">
        <div className="flex items-center gap-2.5">
          <Shield className="w-4.5 h-4.5 text-accent" />
          <h1 className="text-base font-semibold text-text">{t("mailboxCheck.title")}</h1>
          <span className="text-sm text-text-tertiary">{t("mailboxCheck.period")}</span>
        </div>
        {scanning && (
          <span className="flex items-center gap-1.5 text-xs text-text-secondary" role="status">
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
            {t("mailboxCheck.scanning")}
          </span>
        )}
        {accounts.length > 1 && (
          <div className="ml-auto w-60">
            <Select value={accountId} options={accountOptions} onChange={setAccountId} ariaLabel={t("mailboxCheck.allAccounts")} />
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto px-6 py-6 flex flex-col gap-6">
          <p className="flex items-center gap-1.5 text-xs text-text-secondary">
            <Lock className="w-3.5 h-3.5" />
            {t("mailboxCheck.local")}
          </p>

          {state === "loading" && (
            <div className="flex justify-center py-16 text-text-tertiary">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          )}

          {state === "empty" && <EmptyState icon={<Mail className="w-8 h-8" />} title={t("mailboxCheck.list.empty")} />}

          {state === "ready" && overview && report && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Tile
                  icon={<Mail className="w-3.5 h-3.5" />}
                  label={t("mailboxCheck.tiles.newsletters")}
                  value={num(overview.rows.length)}
                  text={t("mailboxCheck.tiles.newslettersText", { count: overview.mails })}
                />
                <Tile
                  icon={<ShieldAlert className="w-3.5 h-3.5" />}
                  label={t("mailboxCheck.tiles.trackers")}
                  value={num(report.total)}
                  text={t("mailboxCheck.tiles.trackersText", { count: report.mails_with_trackers })}
                  signal
                />
                <Tile
                  icon={<MailMinus className="w-3.5 h-3.5" />}
                  label={t("mailboxCheck.tiles.unsubscribed")}
                  value={num(overview.unsubscribed)}
                  text={t("mailboxCheck.tiles.blockedText", { count: overview.blocked })}
                />
              </div>

              <section className="flex flex-col gap-3">
                <div>
                  <h2 className="text-sm font-semibold text-text">{t("mailboxCheck.list.title")}</h2>
                  <p className="text-sm text-text-secondary">{t("mailboxCheck.list.subtitle")}</p>
                </div>
                <div className="rounded-xl border border-border bg-bg overflow-x-auto">
                  <div className="min-w-[720px]">
                    <div className={`${ROW_GRID} px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-text-tertiary`}>
                      <span>{t("mailboxCheck.list.sender")}</span>
                      <span>{t("mailboxCheck.list.volume")}</span>
                      <span>{t("mailboxCheck.list.read")}</span>
                      <span>{t("mailboxCheck.list.trackers")}</span>
                      <span className="text-right">{t("mailboxCheck.list.action")}</span>
                    </div>
                    {rows.length === 0 ? (
                      <p className="px-4 py-6 border-t border-border text-sm text-text-tertiary">{t("mailboxCheck.list.empty")}</p>
                    ) : (
                      rows.map((row) => (
                        <div key={row.key} className={`${ROW_GRID} px-4 py-3 border-t border-border`}>
                          <div className="flex items-center gap-3 min-w-0">
                            <span className="w-8 h-8 shrink-0 rounded-full bg-accent/12 text-accent text-xs font-semibold flex items-center justify-center">
                              {initials(row.name)}
                            </span>
                            <div className="min-w-0">
                              <div className="text-sm font-medium text-text truncate">{row.name}</div>
                              <div className="text-xs text-text-secondary truncate">{row.address}</div>
                            </div>
                          </div>
                          <span className="text-sm text-text tabular-nums">{t("mailboxCheck.list.mails", { count: row.count })}</span>
                          <ReadBar row={row} />
                          {row.trackers > 0 ? (
                            <span className="inline-flex w-fit items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">
                              <ShieldAlert className="w-3 h-3" />
                              {t("mailboxCheck.list.trackerChip", { count: row.trackers })}
                            </span>
                          ) : (
                            <span className="text-xs text-text-tertiary">{t("mailboxCheck.list.noTracker")}</span>
                          )}
                          <div className="flex justify-end min-w-0">
                            {row.subscription ? (
                              <ListStatusChip sub={row.subscription} busy={busyKey === row.key} onAction={(action, id) => void listAction(row, action, id)} />
                            ) : row.offer !== "none" ? (
                              <button
                                type="button"
                                disabled={busyKey === row.key}
                                onClick={() => setPending({ row, mode: row.offer === "block" ? "block" : "unsubscribe" })}
                                className="inline-flex items-center gap-1.5 rounded-control border border-border px-3 py-1.5 text-sm text-text hover:bg-hover disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
                              >
                                {row.offer === "block" ? <UserMinus className="w-4 h-4" /> : <MailMinus className="w-4 h-4" />}
                                {t(row.offer === "block" ? "unsubscribe.block" : "unsubscribe.title")}
                              </button>
                            ) : null}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
                {!showAll && overview.rows.length > FIRST_ROWS && (
                  <button type="button" onClick={() => setShowAll(true)} className="self-start text-sm font-medium text-accent hover:underline">
                    {t("mailboxCheck.list.showAll")} ({num(overview.rows.length)})
                  </button>
                )}
              </section>

              <TrackerPanel report={report} />
            </>
          )}
        </div>
      </div>

      {pending && (
        <UnsubscribeDialog
          mode={pending.mode}
          name={pending.row.name}
          address={pending.row.address}
          onConfirm={(trashExisting) => void confirmPending(trashExisting)}
          onCancel={() => setPending(null)}
        />
      )}
    </div>
  );
}
