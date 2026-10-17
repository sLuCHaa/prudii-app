import { Loader2, AlertCircle } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { SyncProgress } from "../../types";
import { mapImapError } from "../../lib/imapErrorMap";
import { inMailPhase, syncFolderLine, syncStatusKey } from "../../lib/syncProgress";
import { useSyncRun } from "../../hooks/useSyncRun";
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
  const run = useSyncRun(syncProgress);

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

  const statusKey = syncProgress ? syncStatusKey(syncProgress.status) : null;
  const detailLine = syncProgress?.status === "prefetching"
    ? t("sync.prefetching")
    : syncProgress && syncFolderLine(syncProgress);

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
          {syncProgress && inMailPhase(syncProgress) ? (
            <div className="flex flex-col items-center gap-3 py-8">
              <div className="w-16 h-16 rounded-full bg-accent-soft flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-accent animate-spin" />
              </div>
              <div className="text-5xl font-bold tabular-nums">
                <NumberTween from={0} to={run.mails} duration={400} />
              </div>
              <div className="text-sm text-text-secondary">{t("wizard.syncingMails")}</div>
              {detailLine && (
                <div className="text-xs text-text-tertiary tabular-nums">{detailLine}</div>
              )}
              <div className="w-full max-w-xs mt-1">
                <div className="h-1.5 rounded-full bg-border overflow-hidden">
                  <div
                    className="h-full bg-accent rounded-full transition-all duration-300"
                    style={{ width: `${run.percent}%` }}
                  />
                </div>
              </div>
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
                {statusKey ? t(statusKey) : testStatus}
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
