import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Lock, Mail, MailMinus, Shield, ShieldAlert, UserMinus } from "../icons";
import { useAppStore } from "../../stores/appStore";
import { getNewsletterOverview, getTrackerReport } from "../../lib/tauri";
import { runTrackerScan } from "../../lib/trackerScan";
import { checkState, companyBars, initials, readShare, rowCaption } from "../../lib/mailboxCheck";
import { markMailboxCheckSeen } from "../../lib/achievements";
import { useListActions } from "../../hooks/useListActions";
import { Select } from "../ui/Select";
import { EmptyState } from "../ui/EmptyState";
import { UnsubscribeDialog } from "../layout/UnsubscribeDialog";
import { ListStatusChip } from "../layout/ListStatusChip";
import type { NewsletterRow, TrackerReport } from "../../types";

const FIRST_ROWS = 20;
const ROW_GRID = "grid grid-cols-[minmax(0,2.2fr)_minmax(0,0.9fr)_minmax(0,1.2fr)_minmax(0,0.9fr)_minmax(0,2.2fr)] items-center gap-4";
// While bodies load in the background the numbers keep growing; poll instead of waiting for the whole download.
const SCAN_POLL_MS = 4000;
const SHOWN_OTHER_DOMAINS = 3;

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
  const otherDomains = report.other_domains.slice(0, SHOWN_OTHER_DOMAINS);
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
                {bar.other && otherDomains.length > 0 && (
                  <span className="text-xs text-text-tertiary truncate" title={otherDomains.map((d) => `${d.name} (${d.count})`).join(" · ")}>
                    {otherDomains.map((d) => `${d.name} (${d.count.toLocaleString(i18n.language)})`).join(" · ")}
                  </span>
                )}
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
  const queryClient = useQueryClient();
  const accounts = useAppStore((s) => s.accounts);
  const [accountId, setAccountId] = useState("");
  const [scanning, setScanning] = useState(true);
  const [showAll, setShowAll] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [pending, setPending] = useState<{ row: NewsletterRow; mode: "unsubscribe" | "block" } | null>(null);
  const listHeadingRef = useRef<HTMLHeadingElement>(null);
  const account = accountId || undefined;

  const poll = scanning ? SCAN_POLL_MS : false;
  const overviewQuery = useQuery({ queryKey: ["newsletter-overview", accountId], queryFn: () => getNewsletterOverview(account), refetchInterval: poll });
  const reportQuery = useQuery({ queryKey: ["tracker-report", accountId], queryFn: () => getTrackerReport(account), refetchInterval: poll });
  const overview = overviewQuery.data;
  const report = reportQuery.data;

  const refresh = useCallback(() => {
    queryClient.invalidateQueries({ queryKey: ["newsletter-overview"] });
    queryClient.invalidateQueries({ queryKey: ["tracker-report"] });
    queryClient.invalidateQueries({ queryKey: ["list-status"] });
  }, [queryClient]);
  const { unsubscribeOrBlock, listAction } = useListActions(refresh);

  useEffect(() => {
    markMailboxCheckSeen();
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

  // The row may vanish or swap its button for a status line; keep keyboard focus in the list.
  const restoreFocus = useCallback((key: string) => {
    requestAnimationFrame(() => {
      const row = document.querySelector<HTMLElement>(`[data-row-key="${CSS.escape(key)}"]`);
      (row ?? listHeadingRef.current)?.focus();
    });
  }, []);

  const confirmPending = useCallback(async (trashExisting: boolean) => {
    const current = pending;
    setPending(null);
    if (!current) return;
    setBusyKey(current.row.key);
    await unsubscribeOrBlock(current.mode, current.row.sample_mail_id, trashExisting);
    setBusyKey(null);
    restoreFocus(current.row.key);
  }, [pending, unsubscribeOrBlock, restoreFocus]);

  const rowAction = useCallback(async (row: NewsletterRow, action: "retry" | "allow", id: string) => {
    setBusyKey(row.key);
    await listAction(action, id, row.subscription?.display_name ?? row.name);
    setBusyKey(null);
    restoreFocus(row.key);
  }, [listAction, restoreFocus]);

  const accountOptions = useMemo(
    () => [{ value: "", label: t("mailboxCheck.allAccounts") }, ...accounts.map((a) => ({ value: a.id, label: a.email }))],
    [accounts, t],
  );
  const accountLabels = useMemo(() => new Map(accounts.map((a) => [a.id, a.email])), [accounts]);
  const labelAccounts = accounts.length > 1 && !accountId;
  const formatDay = (iso: string) => new Date(iso).toLocaleDateString(i18n.language, { day: "numeric", month: "short" });

  const state = checkState(overview, report, scanning, overviewQuery.isError || reportQuery.isError);
  const rows = overview ? (showAll ? overview.rows : overview.rows.slice(0, FIRST_ROWS)) : [];
  const num = (n: number) => n.toLocaleString(i18n.language);

  return (
    <div className="flex flex-col h-full bg-surface">
      <div className="px-6 py-3 border-b border-border flex flex-wrap items-center gap-x-4 gap-y-2">
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
          <div className="ml-auto w-60 max-w-full">
            <Select value={accountId} options={accountOptions} onChange={setAccountId} ariaLabel={t("mailboxCheck.account")} />
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
            <div className="flex justify-center py-16 text-text-tertiary" aria-busy="true">
              <Loader2 className="w-5 h-5 animate-spin" />
            </div>
          )}

          {state === "error" && (
            <EmptyState
              icon={<ShieldAlert className="w-8 h-8" />}
              title={t("mailboxCheck.loadFailed")}
              action={
                <button
                  type="button"
                  onClick={refresh}
                  className="rounded-control border border-border px-3 py-1.5 text-sm text-text hover:bg-hover focus-visible:outline-2 focus-visible:outline-accent"
                >
                  {t("mailboxCheck.reload")}
                </button>
              }
            />
          )}

          {state === "empty" && <EmptyState icon={<Mail className="w-8 h-8" />} title={t("mailboxCheck.list.empty")} />}

          {state === "ready" && overview && report && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Tile
                  icon={<Mail className="w-3.5 h-3.5" />}
                  label={t("mailboxCheck.tiles.newsletters")}
                  value={num(overview.rows.filter((r) => r.count > 0).length)}
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
                  <h2 ref={listHeadingRef} tabIndex={-1} className="text-sm font-semibold text-text outline-none">
                    {t("mailboxCheck.list.title")}
                  </h2>
                  <p className="text-sm text-text-secondary">{t("mailboxCheck.list.subtitle")}</p>
                </div>
                <div className="rounded-xl border border-border bg-bg overflow-x-auto">
                  <div className="min-w-[760px]" role="table" aria-label={t("mailboxCheck.list.title")}>
                    <div role="row" className={`${ROW_GRID} px-4 py-2 text-[11px] font-medium uppercase tracking-wide text-text-tertiary`}>
                      <span role="columnheader">{t("mailboxCheck.list.sender")}</span>
                      <span role="columnheader">{t("mailboxCheck.list.volume")}</span>
                      <span role="columnheader">{t("mailboxCheck.list.read")}</span>
                      <span role="columnheader">{t("mailboxCheck.list.trackers")}</span>
                      <span role="columnheader" className="text-right">{t("mailboxCheck.list.action")}</span>
                    </div>
                    {rows.length === 0 ? (
                      <p className="px-4 py-6 border-t border-border text-sm text-text-tertiary">{t("mailboxCheck.list.empty")}</p>
                    ) : (
                      rows.map((row) => {
                        const caption = rowCaption(row, labelAccounts ? accountLabels.get(row.account_id) ?? null : null);
                        const busy = busyKey === row.key;
                        return (
                          <div
                            key={row.key}
                            role="row"
                            data-row-key={row.key}
                            tabIndex={-1}
                            aria-busy={busy || undefined}
                            className={`${ROW_GRID} px-4 py-3 border-t border-border outline-none focus-visible:bg-hover`}
                          >
                            <div role="cell" className="flex items-center gap-3 min-w-0">
                              <span aria-hidden="true" className="w-8 h-8 shrink-0 rounded-full bg-accent/12 text-accent text-xs font-semibold flex items-center justify-center">
                                {initials(row.name)}
                              </span>
                              <div className="min-w-0">
                                <div className="text-sm font-medium text-text truncate" title={row.name}>{row.name}</div>
                                {caption && <div className="text-xs text-text-secondary truncate" title={caption}>{caption}</div>}
                              </div>
                            </div>
                            <div role="cell" className="flex flex-col min-w-0">
                              <span className="text-sm text-text tabular-nums">{t("mailboxCheck.list.mails", { count: row.count })}</span>
                              {row.last_received && (
                                <span className="text-xs text-text-tertiary truncate">{t("mailboxCheck.list.last", { date: formatDay(row.last_received) })}</span>
                              )}
                            </div>
                            <div role="cell" className="min-w-0">
                              <ReadBar row={row} />
                            </div>
                            <div role="cell" className="min-w-0">
                              {row.trackers > 0 ? (
                                <span className="inline-flex w-fit items-center gap-1 rounded-full bg-accent/10 px-2 py-0.5 text-xs text-accent">
                                  <ShieldAlert className="w-3 h-3" />
                                  {t("mailboxCheck.list.trackerChip", { count: row.trackers })}
                                </span>
                              ) : (
                                <span className="text-xs text-text-tertiary">{t("mailboxCheck.list.noTracker")}</span>
                              )}
                            </div>
                            <div role="cell" className="flex justify-end min-w-0">
                              {row.subscription ? (
                                <ListStatusChip sub={row.subscription} busy={busy} onAction={(action, id) => void rowAction(row, action, id)} />
                              ) : row.offer !== "none" ? (
                                <button
                                  type="button"
                                  disabled={busy}
                                  onClick={() => setPending({ row, mode: row.offer === "block" ? "block" : "unsubscribe" })}
                                  className="inline-flex items-center gap-1.5 rounded-control border border-border px-3 py-1.5 text-sm text-text hover:bg-hover disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-accent"
                                >
                                  {busy ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : row.offer === "block" ? (
                                    <UserMinus className="w-4 h-4" />
                                  ) : (
                                    <MailMinus className="w-4 h-4" />
                                  )}
                                  {t(row.offer === "block" ? "unsubscribe.block" : "unsubscribe.title")}
                                </button>
                              ) : null}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
                {!showAll && overview.rows.length > FIRST_ROWS && (
                  <button
                    type="button"
                    onClick={() => setShowAll(true)}
                    className="self-start rounded-control text-sm font-medium text-accent hover:underline focus-visible:outline-2 focus-visible:outline-accent"
                  >
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
