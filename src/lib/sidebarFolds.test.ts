import { describe, it, expect } from "vitest";
import { accountCategoriesStartOpen, categoriesFoldKey, isFoldOpen, ownFoldersFoldKey, readFolds, splitFolders, toggleFold } from "./sidebarFolds";
import type { Folder } from "../types";

function folder(id: string, folder_type: Folder["folder_type"] = "custom", is_local = false): Folder {
  return { id, account_id: "a1", name: id, folder_type, path: id, unread_count: 0, total_count: 0, is_local, color: "" };
}

const ids = (list: Folder[]) => list.map((f) => f.id);

describe("isFoldOpen", () => {
  it("falls back to the group's default until the user has touched it", () => {
    expect(isFoldOpen({}, "categories:all", true)).toBe(true);
    expect(isFoldOpen({}, "categories:a1", false)).toBe(false);
  });

  it("keeps what the user chose over the default", () => {
    expect(isFoldOpen({ "categories:all": false }, "categories:all", true)).toBe(false);
    expect(isFoldOpen({ "categories:a1": true }, "categories:a1", false)).toBe(true);
  });
});

describe("toggleFold", () => {
  it("closes a group that is open by default", () => {
    expect(toggleFold({}, "folders:a1", true)).toEqual({ "folders:a1": false });
  });

  it("opens a group that is closed by default", () => {
    expect(toggleFold({}, "categories:a1", false)).toEqual({ "categories:a1": true });
  });

  it("leaves the other groups as they are", () => {
    expect(toggleFold({ "folders:a1": false, "folders:a2": true }, "folders:a1", true)).toEqual({ "folders:a1": true, "folders:a2": true });
  });

  it("returns a new record", () => {
    const folds = { "folders:a1": false };
    expect(toggleFold(folds, "folders:a1", true)).not.toBe(folds);
    expect(folds).toEqual({ "folders:a1": false });
  });
});

describe("readFolds", () => {
  it("reads back what was stored", () => {
    expect(readFolds(JSON.stringify({ "folders:a1": false, "categories:all": true }))).toEqual({ "folders:a1": false, "categories:all": true });
  });

  it("starts empty when nothing was stored", () => {
    expect(readFolds(null)).toEqual({});
  });

  it("starts empty on a damaged entry", () => {
    expect(readFolds("{not json")).toEqual({});
    expect(readFolds("[true]")).toEqual({});
    expect(readFolds("null")).toEqual({});
  });

  it("drops values that are not a yes or no", () => {
    expect(readFolds(JSON.stringify({ "folders:a1": "false", "folders:a2": true }))).toEqual({ "folders:a2": true });
  });
});

describe("fold keys", () => {
  it("keeps the all-inboxes categories apart from an account's", () => {
    expect(categoriesFoldKey(null)).not.toBe(categoriesFoldKey("a1"));
    expect(categoriesFoldKey("a1")).not.toBe(categoriesFoldKey("a2"));
  });

  it("keeps an account's categories apart from its own folders", () => {
    expect(categoriesFoldKey("a1")).not.toBe(ownFoldersFoldKey("a1"));
  });
});

describe("accountCategoriesStartOpen", () => {
  it("opens them for a single account, which has no all-inboxes row", () => {
    expect(accountCategoriesStartOpen(1)).toBe(true);
  });

  it("closes them once the all-inboxes row shows the same categories", () => {
    expect(accountCategoriesStartOpen(2)).toBe(false);
    expect(accountCategoriesStartOpen(5)).toBe(false);
  });
});

describe("splitFolders", () => {
  it("separates the user's own folders from the standard ones", () => {
    const { standard, own } = splitFolders([folder("inbox", "inbox"), folder("offers"), folder("sent", "sent"), folder("planning")]);
    expect(ids(standard)).toEqual(["inbox", "sent"]);
    expect(ids(own)).toEqual(["offers", "planning"]);
  });

  it("counts a local folder as the user's own", () => {
    expect(ids(splitFolders([folder("inbox", "inbox"), folder("keep", "custom", true)]).own)).toEqual(["keep"]);
  });

  it("has no own folders in a fresh account", () => {
    expect(splitFolders([folder("inbox", "inbox"), folder("trash", "trash")]).own).toEqual([]);
  });
});
