import { useEffect, useRef, useCallback } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAccounts } from "./useAccounts";
import { useAppStore } from "../stores/appStore";
import { syncAccount, invalidateConnections } from "../lib/tauri";

interface SyncState {
  [accountId: string]: {
    lastSync: number;
    intervalMinutes: number;
  };
}

export function useAutoSync() {
  const { data: accounts } = useAccounts();
  const queryClient = useQueryClient();
  const syncStateRef = useRef<SyncState>({});
  const timerRef = useRef<number | null>(null);
  const isSyncingRef = useRef(false);
  const accountsRef = useRef(accounts);
  accountsRef.current = accounts;

  const networkStatus = useAppStore((s) => s.networkStatus);
  const prevOnlineRef = useRef(networkStatus === "online");

  const checkAndSync = useCallback(async () => {
    const accounts = accountsRef.current;
    if (!accounts || accounts.length === 0) return;
    // Prevent overlapping sync cycles from the 30s timer
    if (isSyncingRef.current) return;
    isSyncingRef.current = true;

    try {
      const now = Date.now();

      for (const account of accounts) {
        // Skip accounts with manual sync (interval = 0)
        if (account.sync_interval_minutes === 0) continue;

        const state = syncStateRef.current[account.id];
        const intervalMs = account.sync_interval_minutes * 60 * 1000;

        const shouldSync = !state ||
          state.intervalMinutes !== account.sync_interval_minutes ||
          now - state.lastSync >= intervalMs;

        if (shouldSync) {
          try {
            await syncAccount(account.id);

            syncStateRef.current[account.id] = {
              lastSync: now,
              intervalMinutes: account.sync_interval_minutes,
            };
          } catch (err) {
            console.error(`[AutoSync] Failed to sync ${account.email}:`, err);
          }
        }
      }
    } finally {
      isSyncingRef.current = false;
    }
  }, []);

  // On confirmed offline -> online transition: drop stale IMAP sessions and
  // sync immediately instead of waiting up to 30s for the timer.
  useEffect(() => {
    const wasOnline = prevOnlineRef.current;
    const isOnline = networkStatus === "online";
    prevOnlineRef.current = isOnline;

    if (!wasOnline && isOnline) {
      invalidateConnections()
        .catch((err) => console.error("[AutoSync] invalidateConnections failed:", err))
        .finally(() => {
          // Force a sync pass regardless of per-account interval timers
          syncStateRef.current = {};
          checkAndSync();
        });
    }
  }, [networkStatus, checkAndSync]);

  useEffect(() => {
    const CHECK_INTERVAL = 30 * 1000;

    // Initial check after a short delay (let the app settle)
    const initialTimer = setTimeout(() => {
      checkAndSync();
    }, 5000);

    timerRef.current = window.setInterval(() => {
      checkAndSync();
    }, CHECK_INTERVAL);

    return () => {
      clearTimeout(initialTimer);
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [checkAndSync]);

  useEffect(() => {
    if (!accounts) return;

    const accountIds = new Set(accounts.map((a) => a.id));
    for (const id of Object.keys(syncStateRef.current)) {
      if (!accountIds.has(id)) {
        delete syncStateRef.current[id];
      }
    }
  }, [accounts]);
}
