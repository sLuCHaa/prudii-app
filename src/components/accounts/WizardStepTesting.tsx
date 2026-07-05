import { Loader2, AlertCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SyncProgress } from "../../types";
import { mapImapError } from "../../lib/imapErrorMap";
import { parseSyncSubProgress } from "../../lib/syncProgress";
import { Button } from "../ui/Button";
import { NumberTween } from "../motion/NumberTween";
import { useTranslation } from "react-i18next";

interface WizardStepTestingProps {
  /** Current sub-step: waiting for browser OAuth or running IMAP test + sync */
  phase: "oauth_waiting" | "testing";
  testStatus: string;
  testError: string | null;
  syncProgress: SyncProgress | null;
  email: string;
  providerId: string | undefined;
  onBack: () => void;
  onRetry: () => void;
  onSyncInBackground: () => void;
}

export function WizardStepTesting({
  phase,
  testStatus,
  testError,
  syncProgress,
  email,
  providerId,
  onBack,
  onRetry,
  onSyncInBackground,
}: WizardStepTestingProps) {
  const { t } = useTranslation();

  if (phase === "oauth_waiting") {
    return (
      <div className="text-center py-6">
        <div className="w-16 h-16 rounded-full bg-accent-soft flex items-center justify-center mx-auto mb-4">
          <Loader2 className="w-8 h-8 text-accent animate-spin" />
        </div>
        <h3 className="text-lg font-semibold text-text mb-2">
          {t("wizard.waitingForAuth")}
        </h3>
        <p className="text-sm text-text-tertiary mb-4 max-w-xs mx-auto">
          {t("wizard.browserOpened")}
        </p>
      </div>
    );
  }

  const errorHint = testError
    ? mapImapError({ message: testError }, { email, provider: providerId })
    : null;

  // Fetch-phase progress lives in the message ("Fetching X — 3200 of 10323
  // messages..."); new_mails only counts inserted mails and stays 0 while a
  // large folder is being paginated. Show whichever is further along so the
  // counter moves from the first second (same parsing as the sidebar).
  const sub = parseSyncSubProgress(syncProgress?.message ?? "");
  const shownCount = Math.max(syncProgress?.new_mails ?? 0, sub.current);
  const folderCount = syncProgress?.folder_count ?? 0;
  const progressPercent = folderCount > 0
    ? Math.min(
        100,
        (((syncProgress?.folder_index ?? 0) + (sub.total > 0 ? sub.current / sub.total : 0)) / folderCount) * 100
      )
    : 0;

  return (
    <div className="text-center py-6">
      {errorHint ? (
        <>
          <div className="w-16 h-16 rounded-full bg-danger/10 flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-8 h-8 text-danger" />
          </div>
          <h3 className="text-lg font-semibold text-text mb-2">
            {errorHint.title}
          </h3>
          <p className="text-sm text-text-tertiary mb-1 max-w-xs mx-auto">
            {errorHint.detail}
          </p>
          {errorHint.link && (
            <a
              href={errorHint.link}
              onClick={(e) => { e.preventDefault(); openUrl(errorHint.link!); }}
              className="inline-block mb-3 text-accent underline text-xs"
            >
              {errorHint.linkLabel}
            </a>
          )}
          <div className="flex gap-2 justify-center">
            <Button variant="secondary" onClick={onBack}>
              {t("common.back")}
            </Button>
            <Button variant="primary" onClick={onRetry}>
              {t("common.retry")}
            </Button>
          </div>
        </>
      ) : (
        <>
          {syncProgress?.status === "syncing_mails" ? (
            <div className="flex flex-col items-center gap-3 py-8">
              <div className="w-16 h-16 rounded-full bg-accent-soft flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-accent animate-spin" />
              </div>
              <div className="text-5xl font-bold tabular-nums">
                <NumberTween from={0} to={shownCount} duration={400} />
              </div>
              <div className="text-sm text-text-secondary">{t("wizard.syncingMails")}</div>
              {syncProgress.folder_name && folderCount > 0 && (
                <div className="text-xs text-text-tertiary tabular-nums">
                  {syncProgress.folder_name} ({Math.min(syncProgress.folder_index + 1, folderCount)}/{folderCount})
                  {sub.total > 0 && <> — {sub.current.toLocaleString()} / {sub.total.toLocaleString()}</>}
                </div>
              )}
              {folderCount > 0 && (
                <div className="w-full max-w-xs mt-1">
                  <div className="h-1.5 rounded-full bg-border overflow-hidden">
                    <div
                      className="h-full bg-accent rounded-full transition-all duration-300"
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                </div>
              )}
              <div className="mt-2">
                <Button variant="secondary" onClick={onSyncInBackground}>
                  {t("wizard.syncInBackground")}
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className="w-16 h-16 rounded-full bg-accent-soft flex items-center justify-center mx-auto mb-4">
                <Loader2 className="w-8 h-8 text-accent animate-spin" />
              </div>
              <h3 className="text-lg font-semibold text-text mb-2">
                {testStatus}
              </h3>
              <p className="text-sm text-text-tertiary">
                {t("common.pleaseWait")}
              </p>
            </>
          )}
        </>
      )}
    </div>
  );
}
