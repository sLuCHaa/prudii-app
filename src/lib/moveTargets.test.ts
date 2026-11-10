import { describe, it, expect } from "vitest";
import { copyTargets, matchFolders, moveTargets } from "./moveTargets";
import type { Account, Folder } from "../types";

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

describe("matchFolders", () => {
  const byName = (f: Folder) => f.name;
  const folders = [folder("Angebote 2026"), folder("Aufträge"), folder("Planung"), folder("INBOX", "inbox")];

  it("keeps every folder while nothing is typed", () => {
    expect(matchFolders(folders, "", byName)).toBe(folders);
    expect(matchFolders(folders, "   ", byName)).toBe(folders);
  });

  it("finds a folder by any part of its name, whatever the case", () => {
    expect(ids(matchFolders(folders, "GEBO", byName))).toEqual(["Angebote 2026"]);
  });

  it("ignores umlauts and accents on both sides", () => {
    expect(ids(matchFolders(folders, "auftrage", byName))).toEqual(["Aufträge"]);
    expect(ids(matchFolders([folder("Auftrage")], "aufträge", byName))).toEqual(["Auftrage"]);
  });

  it("searches the label the user sees, not the server's name", () => {
    const shown = (f: Folder) => (f.folder_type === "inbox" ? "Posteingang" : f.name);
    expect(ids(matchFolders(folders, "post", shown))).toEqual(["INBOX"]);
    expect(matchFolders(folders, "inbox", shown)).toEqual([]);
  });

  it("ignores spaces around what was typed", () => {
    expect(ids(matchFolders(folders, "  plan ", byName))).toEqual(["Planung"]);
  });

  it("keeps the order of the folders", () => {
    expect(ids(matchFolders(folders, "a", byName))).toEqual(["Angebote 2026", "Aufträge", "Planung"]);
  });
});

describe("copyTargets", () => {
  const account = (id: string, provider: Account["provider"] = "custom", auth_type = "password") =>
    ({ id, email: `${id}@studio-halde.example`, provider, auth_type }) as Account;
  const local = (id: string, account_id: string): Folder => ({ ...folder(id, "custom", account_id), is_local: true });

  const FOLDERS: Record<string, Folder[]> = {
    anna: [folder("anna-inbox", "inbox", "anna")],
    info: [folder("info-inbox", "inbox", "info"), folder("info-drafts", "drafts", "info"), folder("Angebote", "custom", "info"), local("Ablage", "info")],
    gmail: [folder("gmail-inbox", "inbox", "gmail")],
    live: [folder("live-inbox", "inbox", "live")],
    gapp: [folder("gapp-inbox", "inbox", "gapp")],
  };
  const foldersOf = (id: string) => FOLDERS[id] ?? [];
  const groups = (accounts: Account[], source: string | null) =>
    copyTargets(accounts, source, foldersOf).map((g) => [g.account.id, ids(g.folders)]);

  it("offers the server folders of the other accounts", () => {
    expect(groups([account("anna"), account("info")], "anna")).toEqual([["info", ["info-inbox", "Angebote"]]]);
  });

  it("leaves out local folders and drafts", () => {
    const [info] = copyTargets([account("anna"), account("info")], "anna", foldersOf);
    expect(ids(info.folders)).not.toContain("info-drafts");
    expect(ids(info.folders)).not.toContain("Ablage");
  });

  it("leaves out accounts signed in through Google or Microsoft", () => {
    const accounts = [account("anna"), account("gmail", "google", "oauth"), account("live", "microsoft", "oauth")];
    expect(groups(accounts, "anna")).toEqual([]);
  });

  it("keeps a Google account that is connected over IMAP", () => {
    expect(groups([account("anna"), account("gapp", "google", "password")], "anna")).toEqual([["gapp", ["gapp-inbox"]]]);
  });

  it("takes any account as the source", () => {
    expect(groups([account("gmail", "google", "oauth"), account("info")], "gmail")).toEqual([["info", ["info-inbox", "Angebote"]]]);
  });

  it("skips an account whose folders have not loaded", () => {
    expect(groups([account("anna"), account("unknown")], "anna")).toEqual([]);
  });

  it("offers nothing without a source account", () => {
    expect(groups([account("anna"), account("info")], null)).toEqual([]);
  });
});
