import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  updateAppSettings: vi.fn().mockResolvedValue(undefined),
  setWindowTheme: vi.fn().mockResolvedValue(undefined),
}));

import { updateAppSettings } from "../lib/tauri";
import { useAppStore, type ComposeSnapshot } from "./appStore";
import type { Mail, SendMailRequest } from "../types";

describe("appStore — pinned mail selection", () => {
  beforeEach(() => {
    useAppStore.setState({ selectedMailId: null, pinnedMailId: null, selectedFolderId: null, folderSelection: {} });
  });

  it("pins the mail opened from outside the mail list", () => {
    useAppStore.getState().openMailById("acc1", "mail1", "folder1");
    const state = useAppStore.getState();
    expect(state.selectedMailId).toBe("mail1");
    expect(state.pinnedMailId).toBe("mail1");
    expect(state.selectedFolderId).toBe("folder1");
    expect(state.showTasks).toBe(false);
  });

  it("keeps the pin while the same mail is re-selected", () => {
    useAppStore.getState().openMailById("acc1", "mail1", "folder1");
    useAppStore.getState().setSelectedMailId("mail1");
    expect(useAppStore.getState().pinnedMailId).toBe("mail1");
  });

  it("drops the pin on the next selection of a different mail", () => {
    useAppStore.getState().openMailById("acc1", "mail1", "folder1");
    useAppStore.getState().setSelectedMailId("mail2");
    expect(useAppStore.getState().pinnedMailId).toBeNull();

    useAppStore.getState().openMailById("acc1", "mail3", "folder1");
    useAppStore.getState().setSelectedMailId(null);
    expect(useAppStore.getState().pinnedMailId).toBeNull();
  });
});

describe("appStore — choosing a theme", () => {
  beforeEach(() => {
    vi.mocked(updateAppSettings).mockClear();
    useAppStore.setState({ appSettingsLoaded: false });
  });

  it("does not write settings before they were loaded from the database", () => {
    useAppStore.getState().chooseThemeMode("dark");
    expect(useAppStore.getState().themeMode).toBe("dark");
    expect(updateAppSettings).not.toHaveBeenCalled();
  });

  it("persists the chosen mode with the loaded settings", async () => {
    const loaded = { ...useAppStore.getState().appSettings, theme_mode: "system" };
    useAppStore.getState().setAppSettings(loaded);
    useAppStore.getState().chooseThemeMode("light");
    await Promise.resolve();
    expect(updateAppSettings).toHaveBeenCalledWith({ ...loaded, theme_mode: "light" });
    expect(useAppStore.getState().appSettings.theme_mode).toBe("light");
  });
});

describe("appStore — openCategory", () => {
  it("switches to the account that owns the inbox", () => {
    useAppStore.setState({ selectedAccountId: "acc1" });
    useAppStore.getState().openCategory("newsletters", "folder2", "acc2");
    const state = useAppStore.getState();
    expect(state.selectedAccountId).toBe("acc2");
    expect(state.selectedFolderId).toBe("folder2");
    expect(state.activeCategory).toBe("newsletters");
  });

  it("keeps the selected account for the all-inboxes scope", () => {
    useAppStore.setState({ selectedAccountId: "acc1" });
    useAppStore.getState().openCategory("newsletters", null);
    expect(useAppStore.getState().selectedAccountId).toBe("acc1");
    expect(useAppStore.getState().showAllInboxes).toBe(true);
  });
});

describe("appStore — settings that remove the open category", () => {
  it("falls back to the inbox when the open category gets hidden", () => {
    useAppStore.getState().openCategory("newsletters", "folder2", "acc2");
    const settings = useAppStore.getState().appSettings;
    useAppStore.getState().setAppSettings({ ...settings, hidden_categories: ["newsletters"] });
    expect(useAppStore.getState().activeCategory).toBeNull();
    expect(useAppStore.getState().selectedFolderId).toBe("folder2");
  });

  it("falls back to all inboxes when sorting is turned off", () => {
    useAppStore.getState().openCategory("important", null);
    const settings = useAppStore.getState().appSettings;
    useAppStore.getState().setAppSettings({ ...settings, sorting_enabled: false });
    expect(useAppStore.getState().activeCategory).toBeNull();
    expect(useAppStore.getState().showAllInboxes).toBe(true);
  });

  it("keeps the view when a different category gets hidden", () => {
    useAppStore.getState().openCategory("important", null);
    const settings = useAppStore.getState().appSettings;
    useAppStore.getState().setAppSettings({ ...settings, sorting_enabled: true, hidden_categories: ["promotions"] });
    expect(useAppStore.getState().activeCategory).toBe("important");
  });
});

describe("appStore — compose snapshot hand-over", () => {
  const mailA = { id: "mail-a", subject: "Angebot" } as Mail;
  const mailB = { id: "mail-b", subject: "Termin" } as Mail;
  const snapshotA: ComposeSnapshot = {
    to: ["Anna Weber <anna@studio-halde.example>"],
    cc: [],
    bcc: [],
    subject: "Re: Angebot",
    bodyHtml: "<p>Passt so.</p>",
    bodyText: "Passt so.",
    fromAccountId: "acc1",
    attachments: [],
  };
  const requestA = { account_id: "acc1", subject: "Re: Angebot" } as SendMailRequest;

  beforeEach(() => {
    useAppStore.getState().clearUndoSend();
    useAppStore.getState().closeCompose();
  });

  it("opens a reply during the undo countdown without the content being sent", () => {
    useAppStore.getState().startUndoSend(requestA, "reply", mailA, snapshotA);
    useAppStore.getState().openCompose("reply", mailB);
    const state = useAppStore.getState();
    expect(state.composeMail).toBe(mailB);
    expect(state.composeSnapshot).toBeNull();
    expect(state.undoSend.active).toBe(true);
    expect(state.undoSend.composeSnapshot).toBe(snapshotA);
  });

  it("reopens the mail being sent with its content on undo", () => {
    useAppStore.getState().startUndoSend(requestA, "reply", mailA, snapshotA);
    useAppStore.getState().cancelUndoSend();
    const state = useAppStore.getState();
    expect(state.composeOpen).toBe(true);
    expect(state.composeMail).toBe(mailA);
    expect(state.composeSnapshot).toBe(snapshotA);
    expect(state.undoSend.active).toBe(false);
  });

  it("hands a restored autosave to the next compose only, leaving a running send alone", () => {
    const restored = { ...snapshotA, subject: "Entwurf" };
    useAppStore.getState().startUndoSend(requestA, "reply", mailA, snapshotA);
    useAppStore.getState().restoreComposeSnapshot("new", null, restored);
    expect(useAppStore.getState().composeSnapshot).toBe(restored);
    expect(useAppStore.getState().undoSend.composeSnapshot).toBe(snapshotA);
    useAppStore.getState().closeCompose();
    expect(useAppStore.getState().composeSnapshot).toBeNull();
  });
});
