import { describe, it, expect } from "vitest";
import { leavesViewWhenStarred, type StarView } from "./starredInbox";

const FOLDERS = [{ id: "inbox", folder_type: "inbox" as const }, { id: "archive", folder_type: "archive" as const }];

const view = (overrides: Partial<StarView> = {}): StarView => ({
  hideStarredInInbox: true,
  showAllInboxes: false,
  activeCategory: null,
  activeFilter: null,
  folderFilter: "all",
  searchOpen: false,
  selectedFolderId: "inbox",
  folders: FOLDERS,
  ...overrides,
});

describe("leavesViewWhenStarred", () => {
  it("keeps the mail where it is while the setting is off", () => {
    expect(leavesViewWhenStarred(view({ hideStarredInInbox: false }))).toBe(false);
  });

  it("takes it out of an account's inbox", () => {
    expect(leavesViewWhenStarred(view())).toBe(true);
  });

  it("takes it out of the combined inbox", () => {
    expect(leavesViewWhenStarred(view({ showAllInboxes: true, selectedFolderId: null }))).toBe(true);
  });

  it("takes it out of a category of the inbox", () => {
    expect(leavesViewWhenStarred(view({ activeCategory: "newsletters", selectedFolderId: null }))).toBe(true);
  });

  it("leaves it in any other folder", () => {
    expect(leavesViewWhenStarred(view({ selectedFolderId: "archive" }))).toBe(false);
  });

  it("leaves it under the starred pill, which asks for exactly these mails", () => {
    expect(leavesViewWhenStarred(view({ folderFilter: "starred" }))).toBe(false);
  });

  it("leaves it in the starred view and the flag views", () => {
    expect(leavesViewWhenStarred(view({ activeFilter: "starred", selectedFolderId: null }))).toBe(false);
    expect(leavesViewWhenStarred(view({ activeFilter: "red", selectedFolderId: null }))).toBe(false);
  });

  it("leaves it in search results", () => {
    expect(leavesViewWhenStarred(view({ searchOpen: true }))).toBe(false);
  });

  it("leaves it when no folder is open", () => {
    expect(leavesViewWhenStarred(view({ selectedFolderId: null }))).toBe(false);
  });
});
