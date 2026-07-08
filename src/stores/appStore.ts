import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { Account, AppSettings, BackfillProgress, Folder, LicenseInfo, Mail, MailFlag, SendMailRequest, SyncProgress } from "../types";
import type { ComposeMode } from "../components/compose/ComposeModal";
import { parseMailtoUrl, type MailtoParams } from "../lib/mailtoParser";
import type { Update } from "../lib/updater";
import type { ToastData, ToastType } from "../components/ui/Toast";

export interface ComposeSnapshot {
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  bodyHtml: string;
  bodyText: string;
  fromAccountId: string;
  attachments: { name: string; size: number; type: string; data: string }[];
  quotedHtml?: string;
}

export interface UndoSendState {
  active: boolean;
  request: SendMailRequest | null;
  composeMode: ComposeMode;
  composeMail: Mail | null;
  composeSnapshot: ComposeSnapshot | null;
}

type ThemeMode = "light" | "dark" | "system";
export type MailFilter = "starred" | MailFlag | null;
export type FolderFilter = "all" | "unread" | "starred" | "attachments";
export type NetworkStatus = "online" | "offline" | "checking";

function getStoredThemeMode(): ThemeMode {
  return (localStorage.getItem("prudii-theme-mode") as ThemeMode) || "system";
}

function resolveTheme(mode: ThemeMode): boolean {
  if (mode === "system") return window.matchMedia("(prefers-color-scheme: dark)").matches;
  return mode === "dark";
}

function applyTheme(mode: ThemeMode, dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  // followsSystem: in system mode the native appearance must stay unpinned —
  // pinning feeds back into prefers-color-scheme and would freeze "System"
  // on the pinned value (real OS theme only re-detected after restart).
  invoke("set_window_theme", { dark, followsSystem: mode === "system" }).catch(() => {});
}

interface AppState {
  accounts: Account[];
  selectedAccountId: string | null;
  setAccounts: (accounts: Account[]) => void;
  setSelectedAccountId: (id: string | null) => void;

  folders: Folder[];
  selectedFolderId: string | null;
  setFolders: (folders: Folder[]) => void;
  setSelectedFolderId: (id: string | null) => void;

  mails: Mail[];
  selectedMailId: string | null;
  selectedMailIndex: number;
  activeFilter: MailFilter;
  showAllInboxes: boolean;
  activeCombinedFolder: string | null;
  activeSplitId: string | null;
  setMails: (mails: Mail[] | ((prev: Mail[]) => Mail[])) => void;
  setSelectedMailId: (id: string | null) => void;
  setSelectedMailIndex: (index: number) => void;
  setActiveFilter: (filter: MailFilter) => void;
  setShowAllInboxes: (show: boolean) => void;
  setActiveCombinedFolder: (folderType: string | null) => void;
  setActiveSplitId: (splitId: string | null) => void;

  folderFilter: FolderFilter;
  setFolderFilter: (f: FolderFilter) => void;

  selectedMailIds: Set<string>;
  multiSelectMode: boolean;
  lastSelectedMailId: string | null;
  toggleMailSelection: (mailId: string) => void;
  selectMailRange: (toMailId: string, visibleMails: Mail[]) => void;
  selectAllMails: (mailIds: string[]) => void;
  clearSelection: () => void;
  setLastSelectedMailId: (id: string | null) => void;

  // Animation coordination
  pendingRemoveId: string | null;
  setPendingRemoveId: (id: string | null) => void;

  syncProgress: Record<string, SyncProgress>;
  setSyncProgress: (accountId: string, progress: SyncProgress | null) => void;

  backfillProgress: Record<string, BackfillProgress>;
  setBackfillProgress: (accountId: string, progress: BackfillProgress | null) => void;

  licenseInfo: LicenseInfo | null;
  setLicenseInfo: (info: LicenseInfo | null) => void;
  canAddAccount: () => boolean;
  hasFeature: (feature: string) => boolean;

  showSnoozed: boolean;
  setShowSnoozed: (show: boolean) => void;

  showScheduled: boolean;
  setShowScheduled: (show: boolean) => void;

  showAttachmentBrowser: boolean;
  setShowAttachmentBrowser: (show: boolean) => void;

  showAccountWizard: boolean;
  setShowAccountWizard: (show: boolean) => void;
  showSettings: boolean;
  setShowSettings: (show: boolean) => void;
  settingsLastTab: string;
  setSettingsLastTab: (tab: string) => void;

  searchQuery: string;
  searchOpen: boolean;
  setSearchQuery: (query: string) => void;
  setSearchOpen: (open: boolean) => void;

  composeOpen: boolean;
  composeMode: ComposeMode;
  composeMail: Mail | null;
  composeMailtoParams: MailtoParams | null;
  composeAiReplyText: string | null;
  openCompose: (mode: ComposeMode, mail?: Mail | null, aiReplyText?: string | null) => void;
  openMailto: (url: string) => void;
  closeCompose: () => void;

  undoSend: UndoSendState;
  startUndoSend: (request: SendMailRequest, mode: ComposeMode, mail: Mail | null, snapshot: ComposeSnapshot) => void;
  cancelUndoSend: () => void;
  clearUndoSend: () => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
  accountExpandedStates: Record<string, boolean>;
  toggleAccountExpanded: (accountId: string) => void;

  themeMode: ThemeMode;
  darkMode: boolean;
  setThemeMode: (mode: ThemeMode) => void;

  updateAvailable: Update | null;
  setUpdateAvailable: (update: Update | null) => void;

  appSettings: AppSettings;
  setAppSettings: (settings: AppSettings) => void;

  networkStatus: NetworkStatus;
  setNetworkStatus: (status: NetworkStatus) => void;

  trackersBlockedCount: number;
  incrementTrackersBlocked: (n: number) => void;
  resetTrackersBlocked: () => void;

  toasts: ToastData[];
  addToast: (type: ToastType, title: string, message?: string, duration?: number) => void;
  removeToast: (id: string) => void;
}

const initialThemeMode = getStoredThemeMode();

export const useAppStore = create<AppState>((set, get) => ({
  accounts: [],
  selectedAccountId: null,
  setAccounts: (accounts) => set({ accounts }),
  setSelectedAccountId: (selectedAccountId) => set({ selectedAccountId }),

  folders: [],
  selectedFolderId: null,
  setFolders: (folders) => set({ folders }),
  setSelectedFolderId: (selectedFolderId) => set({ selectedFolderId, showSnoozed: false, showScheduled: false, showAttachmentBrowser: false, folderFilter: "all", selectedMailIds: new Set(), multiSelectMode: false, lastSelectedMailId: null }),

  mails: [],
  selectedMailId: null,
  selectedMailIndex: -1,
  activeFilter: null,
  showAllInboxes: false,
  activeCombinedFolder: null,
  setMails: (mails) => set((state) => ({
    mails: typeof mails === "function" ? mails(state.mails) : mails,
  })),
  setSelectedMailId: (selectedMailId) => set({ selectedMailId, selectedMailIds: new Set(), multiSelectMode: false, lastSelectedMailId: null }),
  setSelectedMailIndex: (selectedMailIndex) => set({ selectedMailIndex }),
  setActiveFilter: (activeFilter) => set((state) => ({
    activeFilter,
    // Only clear selectedFolderId when setting a filter, not when clearing it
    selectedFolderId: activeFilter ? null : state.selectedFolderId,
    selectedMailId: null,
    selectedMailIndex: -1,
    showAllInboxes: false,
    activeCombinedFolder: null,
    activeSplitId: null,
    showSnoozed: false,
    showScheduled: false,
    showAttachmentBrowser: false,
    folderFilter: "all",
    selectedMailIds: new Set(),
    multiSelectMode: false,
    lastSelectedMailId: null,
  })),
  setShowAllInboxes: (showAllInboxes) => set({ showAllInboxes, showSnoozed: false, showScheduled: false, showAttachmentBrowser: false, selectedFolderId: null, activeFilter: null, activeCombinedFolder: null, activeSplitId: null, selectedMailId: null, selectedMailIndex: -1, folderFilter: "all", selectedMailIds: new Set(), multiSelectMode: false, lastSelectedMailId: null }),
  setActiveCombinedFolder: (activeCombinedFolder) => set({ activeCombinedFolder, showAllInboxes: false, showSnoozed: false, showScheduled: false, showAttachmentBrowser: false, selectedFolderId: null, activeFilter: null, activeSplitId: null, selectedMailId: null, selectedMailIndex: -1, folderFilter: "all", selectedMailIds: new Set(), multiSelectMode: false, lastSelectedMailId: null }),
  activeSplitId: null,
  setActiveSplitId: (activeSplitId) => set({ activeSplitId, showSnoozed: false, showScheduled: false, showAttachmentBrowser: false, selectedMailId: null, selectedMailIndex: -1, folderFilter: "all", selectedMailIds: new Set(), multiSelectMode: false, lastSelectedMailId: null }),

  folderFilter: "all" as FolderFilter,
  setFolderFilter: (folderFilter) => set({ folderFilter }),

  selectedMailIds: new Set<string>(),
  multiSelectMode: false,
  lastSelectedMailId: null,
  toggleMailSelection: (mailId) => set((state) => {
    const next = new Set(state.selectedMailIds);
    if (next.has(mailId)) {
      next.delete(mailId);
    } else {
      next.add(mailId);
    }
    return {
      selectedMailIds: next,
      multiSelectMode: next.size > 0,
      lastSelectedMailId: next.has(mailId) ? mailId : state.lastSelectedMailId,
    };
  }),
  selectMailRange: (toMailId, visibleMails) => set((state) => {
    const fromId = state.lastSelectedMailId;
    if (!fromId) {
      const next = new Set(state.selectedMailIds);
      next.add(toMailId);
      return { selectedMailIds: next, multiSelectMode: true, lastSelectedMailId: toMailId };
    }
    const fromIdx = visibleMails.findIndex((m) => m.id === fromId);
    const toIdx = visibleMails.findIndex((m) => m.id === toMailId);
    if (fromIdx === -1 || toIdx === -1) return {};
    const start = Math.min(fromIdx, toIdx);
    const end = Math.max(fromIdx, toIdx);
    const next = new Set(state.selectedMailIds);
    for (let i = start; i <= end; i++) {
      next.add(visibleMails[i].id);
    }
    return { selectedMailIds: next, multiSelectMode: true };
  }),
  selectAllMails: (mailIds) => set({
    selectedMailIds: new Set(mailIds),
    multiSelectMode: mailIds.length > 0,
    lastSelectedMailId: null,
  }),
  clearSelection: () => set({
    selectedMailIds: new Set<string>(),
    multiSelectMode: false,
    lastSelectedMailId: null,
  }),
  setLastSelectedMailId: (lastSelectedMailId) => set({ lastSelectedMailId }),

  // Animation coordination
  pendingRemoveId: null,
  setPendingRemoveId: (pendingRemoveId) => set({ pendingRemoveId }),

  syncProgress: {},
  setSyncProgress: (accountId, progress) =>
    set((state) => {
      const next = { ...state.syncProgress };
      if (progress) {
        next[accountId] = progress;
      } else {
        delete next[accountId];
      }
      return { syncProgress: next };
    }),

  backfillProgress: {},
  setBackfillProgress: (accountId, progress) =>
    set((state) => {
      const next = { ...state.backfillProgress };
      if (progress) {
        next[accountId] = progress;
      } else {
        delete next[accountId];
      }
      return { backfillProgress: next };
    }),

  licenseInfo: null,
  setLicenseInfo: (licenseInfo) => set({ licenseInfo }),
  canAddAccount: () => {
    const state = get();
    const plan = state.licenseInfo?.plan || "free";
    if (plan === "premium" || plan === "team") return true;
    return state.accounts.length < 3;
  },
  hasFeature: (feature: string) => {
    const state = get();
    const features = state.licenseInfo?.features || [];
    return features.includes(feature);
  },

  showSnoozed: false,
  setShowSnoozed: (showSnoozed) => set({ showSnoozed, showScheduled: false, showAttachmentBrowser: false, showAllInboxes: false, selectedFolderId: null, activeFilter: null, activeCombinedFolder: null, activeSplitId: null, selectedMailId: null, selectedMailIndex: -1, folderFilter: "all", selectedMailIds: new Set(), multiSelectMode: false, lastSelectedMailId: null }),

  showScheduled: false,
  setShowScheduled: (showScheduled) => set({ showScheduled, showSnoozed: false, showAttachmentBrowser: false, showAllInboxes: false, selectedFolderId: null, activeFilter: null, activeCombinedFolder: null, activeSplitId: null, selectedMailId: null, selectedMailIndex: -1, folderFilter: "all", selectedMailIds: new Set(), multiSelectMode: false, lastSelectedMailId: null }),

  showAttachmentBrowser: false,
  setShowAttachmentBrowser: (showAttachmentBrowser) => set({ showAttachmentBrowser, showSnoozed: false, showScheduled: false, showAllInboxes: false, selectedFolderId: null, activeFilter: null, activeCombinedFolder: null, activeSplitId: null, selectedMailId: null, selectedMailIndex: -1, folderFilter: "all", selectedMailIds: new Set(), multiSelectMode: false, lastSelectedMailId: null }),

  showAccountWizard: false,
  setShowAccountWizard: (showAccountWizard) => set({ showAccountWizard }),
  showSettings: false,
  setShowSettings: (showSettings) => set({ showSettings }),
  settingsLastTab: "general",
  setSettingsLastTab: (settingsLastTab) => set({ settingsLastTab }),

  searchQuery: "",
  searchOpen: false,
  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setSearchOpen: (searchOpen) => set(searchOpen ? { searchOpen } : { searchOpen, searchQuery: "" }),

  composeOpen: false,
  composeMode: "new" as ComposeMode,
  composeMail: null,
  composeMailtoParams: null,
  composeAiReplyText: null,
  openCompose: (mode, mail = null, aiReplyText = null) => set({ composeOpen: true, composeMode: mode, composeMail: mail, composeMailtoParams: null, composeAiReplyText: aiReplyText }),
  openMailto: (url) => set({ composeOpen: true, composeMode: "new" as ComposeMode, composeMail: null, composeMailtoParams: parseMailtoUrl(url), composeAiReplyText: null }),
  closeCompose: () => set({ composeOpen: false, composeMail: null, composeMailtoParams: null, composeAiReplyText: null }),

  undoSend: { active: false, request: null, composeMode: "new" as ComposeMode, composeMail: null, composeSnapshot: null },
  startUndoSend: (request, mode, mail, snapshot) => set({
    composeOpen: false,
    composeMail: null,
    undoSend: { active: true, request, composeMode: mode, composeMail: mail, composeSnapshot: snapshot },
  }),
  cancelUndoSend: () => set((state) => ({
    composeOpen: true,
    composeMode: state.undoSend.composeMode,
    composeMail: state.undoSend.composeMail,
    undoSend: { ...state.undoSend, active: false },
  })),
  clearUndoSend: () => set({
    undoSend: { active: false, request: null, composeMode: "new" as ComposeMode, composeMail: null, composeSnapshot: null },
  }),

  sidebarCollapsed: localStorage.getItem("prudii-sidebar-collapsed") === "true",
  toggleSidebar: () => set((state) => {
    const next = !state.sidebarCollapsed;
    localStorage.setItem("prudii-sidebar-collapsed", String(next));
    return { sidebarCollapsed: next };
  }),
  accountExpandedStates: (() => {
    try { return JSON.parse(localStorage.getItem("prudii-account-expanded") || "{}"); } catch { return {}; }
  })(),
  toggleAccountExpanded: (accountId) => set((state) => {
    const current = state.accountExpandedStates[accountId] ?? true;
    const next = { ...state.accountExpandedStates, [accountId]: !current };
    localStorage.setItem("prudii-account-expanded", JSON.stringify(next));
    return { accountExpandedStates: next };
  }),

  themeMode: initialThemeMode,
  darkMode: resolveTheme(initialThemeMode),
  setThemeMode: (mode) => {
    localStorage.setItem("prudii-theme-mode", mode);
    const dark = resolveTheme(mode);
    applyTheme(mode, dark);
    set({ themeMode: mode, darkMode: dark });
  },

  updateAvailable: null,
  setUpdateAvailable: (update) => {
    const prev = get().updateAvailable;
    if (prev && prev !== update) { void prev.close(); }
    set({ updateAvailable: update });
  },

  appSettings: {
    launch_on_startup: false,
    show_in_tray: true,
    use_24h_clock: true,
    show_all_unread_counts: false,
    notifications_enabled: true,
    notification_sound: true,
    language: "system",
    density: "comfortable",
    accent_color: "blue",
    ai_enabled: false,
    ollama_url: "http://localhost:11434",
    ai_model: "",
    undo_send_delay: 5,
    theme_mode: "system",
    transparent_sidebar: true,
    strip_tracking_params: true,
  },
  setAppSettings: (appSettings) => set({ appSettings }),

  networkStatus: navigator.onLine ? "online" : "offline",
  setNetworkStatus: (status) => set({ networkStatus: status }),

  trackersBlockedCount: 0,
  incrementTrackersBlocked: (n) => set((state) => ({ trackersBlockedCount: state.trackersBlockedCount + n })),
  resetTrackersBlocked: () => set({ trackersBlockedCount: 0 }),

  toasts: [],
  addToast: (type, title, message, duration) => {
    const id = `toast-${Date.now()}-${Math.random()}`;
    const toast: ToastData = { id, type, title, message, duration };
    set((state) => ({ toasts: [...state.toasts, toast] }));
  },
  removeToast: (id) => {
    set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) }));
  },
}));
