import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../lib/tauri", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/tauri")>()),
  updateAppSettings: vi.fn().mockResolvedValue(undefined),
  setWindowTheme: vi.fn().mockResolvedValue(undefined),
}));

import { updateAppSettings } from "../lib/tauri";
import { useAppStore } from "./appStore";

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
