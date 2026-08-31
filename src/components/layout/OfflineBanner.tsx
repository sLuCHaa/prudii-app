import { WifiOff, RefreshCw, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { checkConnectivity } from "../../lib/tauri";

export function OfflineBanner() {
  const { t } = useTranslation();
  const networkStatus = useAppStore((s) => s.networkStatus);
  const setNetworkStatus = useAppStore((s) => s.setNetworkStatus);

  const offline = networkStatus !== "online";
  const checking = networkStatus === "checking";

  async function retry() {
    setNetworkStatus("checking");
    try {
      const reachable = await checkConnectivity();
      setNetworkStatus(reachable ? "online" : "offline");
    } catch {
      setNetworkStatus("offline");
    }
  }

  return (
    // Live region: going offline is announced to screen readers.
    <div role="status" aria-live="polite" className={`reveal-y ${offline ? "reveal-open" : ""}`} aria-hidden={!offline}>
      <div className="min-h-0 overflow-hidden">
    <div className="flex items-center justify-between gap-2 px-4 py-2 bg-warning/10 border-b border-warning/30 text-xs text-text">
      <div className="flex items-center gap-2">
        {checking ? (
          <Loader2 className="w-3.5 h-3.5 text-warning animate-spin" />
        ) : (
          <WifiOff className="w-3.5 h-3.5 text-warning" />
        )}
        <span>{checking ? t("offline.checking") : t("offline.message")}</span>
      </div>
      <button
        type="button"
        onClick={retry}
        disabled={checking}
        tabIndex={offline ? 0 : -1}
        className="flex items-center gap-1 px-2 py-1 rounded hover:bg-hover transition-colors text-text-secondary disabled:opacity-50"
      >
        <RefreshCw className="w-3 h-3" />
        {t("offline.retry")}
      </button>
    </div>
      </div>
    </div>
  );
}
