import { describe, it, expect } from "vitest";
import { moveTargets } from "./moveTargets";
import type { Folder } from "../types";

function folder(id: string, folder_type: Folder["folder_type"] = "custom", account_id = "a1"): Folder {
  return {
    id,
    account_id,
    name: id,
    folder_type,
    path: id,
    unread_count: 0,
    total_count: 0,
    is_local: false,
    color: "",
  };
}

const ids = (list: Folder[]) => list.map((f) => f.id);

describe("moveTargets", () => {
  it("offers every folder but the one the mail is already in", () => {
    const folders = [folder("inbox", "inbox"), folder("archive", "archive"), folder("projects")];
    expect(ids(moveTargets(folders, "inbox"))).toEqual(["archive", "projects"]);
  });

  it("never offers drafts", () => {
    const folders = [folder("inbox", "inbox"), folder("drafts", "drafts")];
    expect(ids(moveTargets(folders, "inbox"))).toEqual([]);
  });

  it("keeps every folder when the source is unknown", () => {
    // A combined view has no single open folder; nothing should be hidden then.
    const folders = [folder("inbox", "inbox"), folder("archive", "archive")];
    expect(ids(moveTargets(folders, null))).toEqual(["inbox", "archive"]);
  });

  it("preserves the order it was given", () => {
    const folders = [folder("z"), folder("a"), folder("m")];
    expect(ids(moveTargets(folders, null))).toEqual(["z", "a", "m"]);
  });

  it("returns nothing for an account whose folders have not loaded", () => {
    expect(moveTargets([], "inbox")).toEqual([]);
  });

  it("does not mutate the list it was given", () => {
    const folders = [folder("inbox", "inbox"), folder("archive", "archive")];
    moveTargets(folders, "inbox");
    expect(ids(folders)).toEqual(["inbox", "archive"]);
  });

  it("matches the source folder by id, not by name or type", () => {
    // Two accounts can both have an "Archive"; only the mail's own folder drops out.
    const folders = [folder("a1-archive", "archive", "a1"), folder("a2-archive", "archive", "a2")];
    expect(ids(moveTargets(folders, "a1-archive"))).toEqual(["a2-archive"]);
  });
});
