import { useEffect, useRef } from "react";
import { useAppStore } from "../stores/appStore";
import { checkConnectivity } from "../lib/tauri";

const OFFLINE_POLL_MS = 15_000;

/**
 * Authoritative network status: confirms OS online/offline events with a real
 * reachability check, and polls while offline so a returned connection is
 * detected even when no "online" event fires.
 */
export function useConnectivity(): void {
  const setNetworkStatus = useAppStore((s) => s.setNetworkStatus);
  const pollRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function confirm() {
      setNetworkStatus("checking");
      let reachable = false;
      try {
        reachable = await checkConnectivity();
      } catch {
        reachable = false;
      }
      if (cancelled) return;
      setNetworkStatus(reachable ? "online" : "offline");
      managePoll(reachable);
    }

    function managePoll(online: boolean) {
      if (online) {
        if (pollRef.current !== null) {
          clearInterval(pollRef.current);
          pollRef.current = null;
        }
      } else if (pollRef.current === null) {
        pollRef.current = window.setInterval(() => {
          checkConnectivity()
            .then((reachable) => {
              if (cancelled) return;
              if (reachable) {
                setNetworkStatus("online");
                managePoll(true);
              }
            })
            .catch(() => {});
        }, OFFLINE_POLL_MS);
      }
    }

    const onOnline = () => confirm();
    const onOffline = () => {
      setNetworkStatus("offline");
      managePoll(false);
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);

    confirm();

    return () => {
      cancelled = true;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      if (pollRef.current !== null) clearInterval(pollRef.current);
    };
  }, [setNetworkStatus]);
}
