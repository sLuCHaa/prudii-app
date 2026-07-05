import { lazy, Suspense, useEffect, useRef, useState } from "react";
const MotionLab = import.meta.env.DEV
  ? lazy(() => import("./components/motion/MotionLab").then((m) => ({ default: m.MotionLab })))
  : null;
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { AppLayout } from "./components/layout/AppLayout";
import { SplashScreen } from "./components/ui/SplashScreen";
import { DialogProvider } from "./components/ui/DialogProvider";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { UndoToast } from "./components/ui/UndoToast";
import { ToastContainer } from "./components/ui/Toast";
import { CommandPalette } from "./components/ui/CommandPalette";
import { ShortcutHelp } from "./components/ui/ShortcutHelp";
// Eager (not lazy): ComposeWindow IS the entire content of the compose window
// (index.html?compose=true), so lazy-loading it just delays that window's open.
import { ComposeWindow } from "./components/compose/ComposeWindow";
import { useAppStore } from "./stores/appStore";
import { useSyncAll } from "./hooks/useSync";
import { useAutoSync } from "./hooks/useAutoSync";
import { useConnectivity } from "./hooks/useConnectivity";
import { backfillBodies, getAppSettings, checkLicenseStartup, getStartupMailto, checkSnoozedMails, checkScheduledMails, classifyUnclassifiedMails, checkForUpdate } from "./lib/tauri";
import { checkFirstHundredOnce } from "./lib/achievements";
import { useDialog } from "./components/ui/DialogProvider";
import { useTranslation } from "react-i18next";
import i18next from "i18next";
import type { BackfillProgress, BackupProgress, SyncProgress } from "./types";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnReconnect: true,
    },
  },
});

function AppInner() {
  const [showSplash, setShowSplash] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [showMotionLab, setShowMotionLab] = useState(false);
  const themeMode = useAppStore((s) => s.themeMode);
  const setThemeMode = useAppStore((s) => s.setThemeMode);
  const setShowAccountWizard = useAppStore((s) => s.setShowAccountWizard);
  const accounts = useAppStore((s) => s.accounts);
  const syncAll = useSyncAll();
  const queryClient = useQueryClient();
  const hasSynced = useRef(false);

  useAutoSync();

  useConnectivity();

  useEffect(() => {
    setThemeMode(themeMode);

    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      if (useAppStore.getState().themeMode === "system") {
        setThemeMode("system");
      }
    };
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, []);

  const setAppSettings = useAppStore((s) => s.setAppSettings);
  useEffect(() => {
    getAppSettings().then((s) => {
      setAppSettings(s);
      // Theme boots from localStorage (no flash); once the DB value is known
      // it wins, so a backup restore brings the theme back. setThemeMode
      // also re-syncs localStorage.
      const store = useAppStore.getState();
      const dbTheme = s.theme_mode as "light" | "dark" | "system";
      if (dbTheme && dbTheme !== store.themeMode) {
        store.setThemeMode(dbTheme);
      }
    }).catch(console.error);
  }, []);

  const setLicenseInfo = useAppStore((s) => s.setLicenseInfo);
  useEffect(() => {
    checkLicenseStartup().then((info) => setLicenseInfo(info)).catch(console.error);
    const interval = setInterval(() => {
      checkLicenseStartup().then((info) => setLicenseInfo(info)).catch(console.error);
    }, 12 * 60 * 60 * 1000);
    return () => clearInterval(interval);
  }, []);

  const appSettings = useAppStore((s) => s.appSettings);
  useEffect(() => {
    document.documentElement.setAttribute("data-accent", appSettings.accent_color);
    document.documentElement.setAttribute("data-density", appSettings.density);
  }, [appSettings.accent_color, appSettings.density]);

  // Apply the native translucent-sidebar window effect (macOS vibrancy only;
  // Windows/Linux render the in-app SidebarAmbient tint instead).
  // Re-runs on toggle and theme change; data-vibrancy gates the CSS.
  const darkMode = useAppStore((s) => s.darkMode);
  useEffect(() => {
    invoke<boolean>("set_vibrancy", {
      enabled: appSettings.transparent_sidebar,
      dark: darkMode,
    })
      .then((supported) => {
        document.documentElement.toggleAttribute(
          "data-vibrancy",
          supported && appSettings.transparent_sidebar
        );
      })
      .catch(() => {});
  }, [appSettings.transparent_sidebar, darkMode]);

  useEffect(() => {
    if (!hasSynced.current && accounts.length > 0) {
      hasSynced.current = true;
      syncAll.mutate();
    }
  }, [accounts.length]);

  useEffect(() => {
    const unlisten = listen<SyncProgress>("sync-progress", (event) => {
      const progress = event.payload;
      // "skipped" = sync lock rejected a duplicate request — ignore it
      if (progress.status === "skipped") return;
      if (progress.status === "done") {
        useAppStore.getState().setSyncProgress(progress.account_id, progress);
        // Refetch all mail-related queries now that sync is actually complete.
        // refetchQueries forces an immediate refetch (not just marking stale).
        queryClient.refetchQueries({ queryKey: ["folders", progress.account_id] });
        queryClient.refetchQueries({ queryKey: ["mails"] });
        queryClient.refetchQueries({ queryKey: ["filtered-mails"] });
        queryClient.refetchQueries({ queryKey: ["all-inbox-mails"] });
        queryClient.refetchQueries({ queryKey: ["combined-folder-mails"] });
        queryClient.refetchQueries({ queryKey: ["split-inbox-mails"] });
        queryClient.invalidateQueries({ queryKey: ["accounts"] });
        // Backfill mail bodies in the background for FTS search
        backfillBodies(progress.account_id).catch(() => {});
        // Classify new mails with header-based heuristics (premium)
        if (useAppStore.getState().hasFeature("auto_labels")) {
          classifyUnclassifiedMails().catch(() => {});
        }
        const newMails = typeof progress.new_mails === "number" ? progress.new_mails : 0;
        if (newMails > 0) {
          useAppStore.getState().addToast(
            "success",
            i18next.t("sync.doneNew", { count: newMails }),
          );
          if (newMails >= 100 && checkFirstHundredOnce()) {
            useAppStore.getState().addToast(
              "success",
              i18next.t("achievements.firstHundredTitle"),
              i18next.t("achievements.firstHundredDesc"),
            );
          }
        }
        setTimeout(() => {
          useAppStore.getState().setSyncProgress(progress.account_id, null);
        }, 2000);
      } else {
        useAppStore.getState().setSyncProgress(progress.account_id, progress);
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [queryClient]);

  useEffect(() => {
    const unlistenProgress = listen<BackfillProgress>("backfill-progress", (event) => {
      useAppStore.getState().setBackfillProgress(event.payload.account_id, event.payload);
    });
    const unlistenDone = listen<{ account_id: string }>("backfill-done", (event) => {
      setTimeout(() => {
        useAppStore.getState().setBackfillProgress(event.payload.account_id, null);
      }, 2000);
    });
    return () => {
      unlistenProgress.then((fn) => fn());
      unlistenDone.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<BackupProgress>("restore-progress", (event) => {
      if (event.payload.status === "done") {
        queryClient.invalidateQueries({ queryKey: ["accounts"] });
        queryClient.invalidateQueries({ queryKey: ["mails"] });
        queryClient.invalidateQueries({ queryKey: ["filtered-mails"] });
        queryClient.invalidateQueries({ queryKey: ["all-inbox-mails"] });
        queryClient.invalidateQueries({ queryKey: ["combined-folder-mails"] });
        queryClient.invalidateQueries({ queryKey: ["split-inbox-mails"] });
      }
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [queryClient]);

  const dialog = useDialog();
  const { t } = useTranslation();
  useEffect(() => {
    const unlisten = listen<{ emails: string[] }>("restore-needs-passwords", (event) => {
      const emails = event.payload.emails;
      if (emails.length > 0) {
        const allAccounts = useAppStore.getState().accounts;
        const oauthEmails: string[] = [];
        const passwordEmails: string[] = [];
        for (const email of emails) {
          const acc = allAccounts.find((a) => a.email === email);
          if (acc && (acc.provider === "google" || acc.provider === "microsoft")) {
            oauthEmails.push(email);
          } else {
            passwordEmails.push(email);
          }
        }
        let message = "";
        if (passwordEmails.length > 0) {
          message += t("backup.passwordsNeededDesc") + "\n" + passwordEmails.join("\n");
        }
        if (oauthEmails.length > 0) {
          if (message) message += "\n\n";
          message += t("backup.oauthNeededDesc") + "\n" + oauthEmails.join("\n");
        }
        dialog.alert({
          type: "info",
          title: t("backup.passwordsNeeded"),
          message,
        });
      }
    });
    return () => { unlisten.then((fn) => fn()); };
  }, [dialog, t]);

  // Listen for mailto: deep-links (when app is already running and another instance passes a mailto URL)
  useEffect(() => {
    const unlisten = listen<string>("mailto-open", (event) => {
      useAppStore.getState().openMailto(event.payload);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    const unlisten = listen<{ account_id: string; mail_id: string; folder_id: string }>(
      "notification-clicked",
      (event) => {
        const { account_id, mail_id, folder_id } = event.payload;
        useAppStore.getState().setSelectedAccountId(account_id);
        useAppStore.setState({
          showAllInboxes: false,
          activeCombinedFolder: null,
          activeFilter: null,
          activeSplitId: null,
          selectedFolderId: folder_id,
          selectedMailId: mail_id,
          selectedMailIndex: -1,
          folderFilter: "all",
          selectedMailIds: new Set(),
          multiSelectMode: false,
          lastSelectedMailId: null,
        });
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  // Listen for undo-send-start from compose window → trigger undo-send in main window
  useEffect(() => {
    const unlisten = listen<{
      request: import("./types").SendMailRequest;
      mode: import("./components/compose/ComposeModal").ComposeMode;
      originalMail: import("./types").Mail | null;
      snapshot: import("./stores/appStore").ComposeSnapshot;
    }>("undo-send-start", (event) => {
      const { request, mode, originalMail, snapshot } = event.payload;
      useAppStore.getState().startUndoSend(request, mode, originalMail, snapshot);
    });
    return () => { unlisten.then((fn) => fn()); };
  }, []);

  useEffect(() => {
    getStartupMailto().then((url) => {
      if (url) useAppStore.getState().openMailto(url);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden) return;
      checkSnoozedMails().then((count) => {
        if (count > 0) {
          queryClient.refetchQueries({ queryKey: ["mails"] });
          queryClient.refetchQueries({ queryKey: ["all-inbox-mails"] });
          queryClient.refetchQueries({ queryKey: ["combined-folder-mails"] });
        }
      }).catch(() => {});
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [queryClient]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (document.hidden) return;
      checkScheduledMails().then((count) => {
        if (count > 0) {
          queryClient.refetchQueries({ queryKey: ["mails"] });
          queryClient.refetchQueries({ queryKey: ["all-inbox-mails"] });
        }
      }).catch(() => {});
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [queryClient]);

  // Listen for permanently failed scheduled sends → alert user
  useEffect(() => {
    const unlisten = listen<{ draft_id: string; subject: string; error: string }>(
      "scheduled-mail-failed",
      (event) => {
        const { subject, error } = event.payload;
        dialog.alert({
          type: "danger",
          title: t("scheduled.failedTitle"),
          message: `${t("scheduled.failedMessage", { subject })}\n\n${error}`,
        });
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, [dialog, t]);

  // Mail was sent successfully via SMTP but saving to Sent folder failed.
  // Non-blocking warning so user knows (mail was delivered, just not archived locally).
  const addToast = useAppStore((s) => s.addToast);
  useEffect(() => {
    const unlisten = listen<{ account_id: string; error: string }>(
      "sent-folder-save-failed",
      (event) => {
        addToast(
          "warning",
          t("errors.sentFolderSaveTitle"),
          event.payload.error,
        );
      },
    );
    return () => { unlisten.then((fn) => fn()); };
  }, [addToast, t]);

  // Auto-check for updates: on startup, every 6 hours, and when network
  // connectivity is regained. A long-running desktop app (tray) may stay open
  // for days, so a one-shot startup check would never surface later releases.
  const setUpdateAvailable = useAppStore((s) => s.setUpdateAvailable);
  useEffect(() => {
    const RECHECK_INTERVAL = 6 * 60 * 60 * 1000;
    let cancelled = false;

    const runCheck = () => {
      checkForUpdate()
        .then((release) => { if (!cancelled && release) setUpdateAvailable(release); })
        .catch(() => {});
    };

    runCheck();
    const interval = window.setInterval(runCheck, RECHECK_INTERVAL);
    window.addEventListener("online", runCheck);

    return () => {
      cancelled = true;
      clearInterval(interval);
      window.removeEventListener("online", runCheck);
    };
  }, [setUpdateAvailable]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const target = e.target as HTMLElement;
      if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

      // 'c' for compose (placeholder)
      if (e.key === "c" && !e.ctrlKey && !e.metaKey) {
        // Compose - placeholder
      }

      // '/' for search - handled by MailList
      if (e.key === "/") {
        e.preventDefault();
      }

      if (e.key === "a" && !e.ctrlKey && !e.metaKey) {
        if (useAppStore.getState().canAddAccount()) {
          setShowAccountWizard(true);
        }
      }

      if (import.meta.env.DEV && e.key === "M" && e.ctrlKey && e.shiftKey) {
        e.preventDefault();
        setShowMotionLab((v) => !v);
      }

      if (e.key === "?") {
        e.preventDefault();
        setShowHelp(true);
      }
    }

    function handleOpenHelp() {
      setShowHelp(true);
    }

    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("prudii:open-help", handleOpenHelp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("prudii:open-help", handleOpenHelp);
    };
  }, [setShowAccountWizard, setShowHelp]);

  if (showSplash) {
    return <SplashScreen onComplete={() => setShowSplash(false)} duration={2500} />;
  }

  return (
    <>
      <AppLayout />
      <UndoToast />
      <ToastContainer />
      <CommandPalette />
      <ShortcutHelp isOpen={showHelp} onClose={() => setShowHelp(false)} />
      {import.meta.env.DEV && showMotionLab && MotionLab && (
        <Suspense fallback={null}>
          <MotionLab onClose={() => setShowMotionLab(false)} />
        </Suspense>
      )}
    </>
  );
}

const isComposeWindow = new URLSearchParams(window.location.search).has("compose");

export default function App() {
  if (isComposeWindow) {
    return (
      <ErrorBoundary>
        <Suspense fallback={null}>
          <ComposeWindow />
        </Suspense>
      </ErrorBoundary>
    );
  }

  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <DialogProvider>
          <AppInner />
        </DialogProvider>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
