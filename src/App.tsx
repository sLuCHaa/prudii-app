import { lazy, Suspense, useEffect, useRef, useState } from "react";
const MotionLab = import.meta.env.DEV
  ? lazy(() => import("./components/motion/MotionLab").then((m) => ({ default: m.MotionLab })))
  : null;
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
// Separate chunks: the compose window must not parse the main layout, and
// the main window must not parse the editor.
const AppLayout = lazy(() =>
  import("./components/layout/AppLayout").then((m) => ({ default: m.AppLayout }))
);
import { SplashScreen } from "./components/ui/SplashScreen";
import { DialogProvider } from "./components/ui/DialogProvider";
import { ErrorBoundary } from "./components/ui/ErrorBoundary";
import { UndoToast } from "./components/ui/UndoToast";
import { ToastContainer } from "./components/ui/Toast";
import { CommandPalette } from "./components/ui/CommandPalette";
import { ShortcutHelp } from "./components/ui/ShortcutHelp";
const ComposeWindow = lazy(() =>
  import("./components/compose/ComposeWindow").then((m) => ({ default: m.ComposeWindow }))
);
import { useAppStore } from "./stores/appStore";
import { useSyncAll } from "./hooks/useSync";
import { useAutoSync } from "./hooks/useAutoSync";
import { useConnectivity } from "./hooks/useConnectivity";
import { backfillBodies, getAppSettings, checkLicenseStartup, getStartupMailto, checkSnoozedMails, checkScheduledMails, classifyUnclassifiedMails } from "./lib/tauri";
import { checkForUpdate } from "./lib/updater";
import { installGlobalTooltips } from "./lib/globalTooltips";
import { checkFirstHundredOnce } from "./lib/achievements";
import { playSentSound } from "./lib/sounds";
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
      refetchOnWindowFocus: false,
    },
  },
});

// Refresh only the queries currently on screen; hidden views refetch when
// they next mount instead of all re-hitting the DB at once.
function refreshMailQueries(accountId: string) {
  queryClient.invalidateQueries({ queryKey: ["folders", accountId], refetchType: "active" });
  for (const key of ["mails", "filtered-mails", "all-inbox-mails", "combined-folder-mails", "split-inbox-mails"]) {
    queryClient.invalidateQueries({ queryKey: [key], refetchType: "active" });
  }
}

function AppInner() {
  // Once per launch in production; never in dev (rebuilds relaunch the app).
  const [showSplash, setShowSplash] = useState(
    () => !import.meta.env.DEV && !sessionStorage.getItem("splash-shown")
  );
  useEffect(() => {
    sessionStorage.setItem("splash-shown", "1");
  }, []);
  const [layoutReady, setLayoutReady] = useState(false);
  const [splashDone, setSplashDone] = useState(false);
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
        refreshMailQueries(progress.account_id);
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

  // Dispatch native macOS menu bar actions (see src-tauri/src/lib.rs)
  useEffect(() => {
    const unlisten = listen<string>("menu", (event) => {
      const s = useAppStore.getState();
      const selected = s.mails.find((m) => m.id === s.selectedMailId) ?? null;
      switch (event.payload) {
        case "menu:new_message": s.openCompose("new"); break;
        case "menu:settings": s.setShowSettings(true); break;
        case "menu:sync_all": syncAll.mutate(); break;
        case "menu:reply": if (selected) s.openCompose("reply", selected); break;
        case "menu:reply_all": if (selected) s.openCompose("replyAll", selected); break;
        case "menu:forward": if (selected) s.openCompose("forward", selected); break;
      }
    });
    return () => { unlisten.then((fn) => fn()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // A saved draft is written straight to the local DB, so the list can refresh without
  // waiting for the sync that follows it.
  useEffect(() => {
    const unlisten = listen<{ account_id: string }>("mails-changed", (event) => {
      refreshMailQueries(event.payload.account_id);
    });
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

  // One shared 5-minute tick for due snoozes and scheduled sends.
  useEffect(() => {
    const refreshLists = () => {
      queryClient.invalidateQueries({ queryKey: ["mails"], refetchType: "active" });
      queryClient.invalidateQueries({ queryKey: ["all-inbox-mails"], refetchType: "active" });
      queryClient.invalidateQueries({ queryKey: ["combined-folder-mails"], refetchType: "active" });
    };
    const interval = setInterval(() => {
      if (document.hidden) return;
      checkSnoozedMails().then((count) => { if (count > 0) refreshLists(); }).catch(() => {});
      checkScheduledMails().then((count) => { if (count > 0) refreshLists(); }).catch(() => {});
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

  // Send/schedule confirmations from compose windows — those windows destroy
  // themselves before the outcome is visible, so the feedback lives here.
  const addToast = useAppStore((s) => s.addToast);
  useEffect(() => {
    const sentFeedback = (message?: string) => {
      if (useAppStore.getState().appSettings.notification_sound) playSentSound();
      addToast("success", t("undoSend.messageSent"), message);
    };
    const unlistenSent = listen("mail-sent", () => sentFeedback());
    const unlistenScheduled = listen<{ scheduled_at: string }>("mail-scheduled", (event) => {
      addToast(
        "success",
        t("scheduled.mailScheduled"),
        new Date(event.payload.scheduled_at).toLocaleString(),
      );
    });
    const unlistenScheduledSent = listen<{ subject: string }>("scheduled-mail-sent", (event) => {
      sentFeedback(event.payload.subject);
    });
    return () => {
      unlistenSent.then((fn) => fn());
      unlistenScheduled.then((fn) => fn());
      unlistenScheduledSent.then((fn) => fn());
    };
  }, [addToast, t]);

  // Mail was sent successfully via SMTP but saving to Sent folder failed.
  // Non-blocking warning so user knows (mail was delivered, just not archived locally).
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
        .then((update) => { if (!cancelled && update) setUpdateAvailable(update); })
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

      if (e.key === "c" && !e.ctrlKey && !e.metaKey && !e.altKey) {
        e.preventDefault();
        useAppStore.getState().openCompose("new");
      }

      if (e.key === "/") {
        e.preventDefault();
        useAppStore.getState().setSearchOpen(true);
      }

      // Bare 'a' belongs to archive (MailList) — the wizard is a rare,
      // once-per-install action and must not fire mid-triage.
      if (e.key === "A" && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
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

  // The splash gates on the layout chunk plus a minimum display time.
  useEffect(() => {
    import("./components/layout/AppLayout").then(() => setLayoutReady(true));
  }, []);

  useEffect(() => {
    if (layoutReady && splashDone) setShowSplash(false);
  }, [layoutReady, splashDone]);

  if (showSplash) {
    // Short brand moment only — the real gate is layoutReady. A long fixed
    // duration here is pure added startup latency on every cold launch.
    return <SplashScreen onComplete={() => setSplashDone(true)} duration={400} />;
  }

  return (
    <>
      <Suspense fallback={null}>
        <AppLayout />
      </Suspense>
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
  useEffect(() => installGlobalTooltips(), []);
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
