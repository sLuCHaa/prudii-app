import { describe, it, expect } from "vitest";
import i18n from "./i18n";
import { defaultFolderIds, buildExportLabels } from "./mailExport";
import type { Folder, FolderType } from "../types";

function folder(id: string, folder_type: FolderType): Folder {
  return { id, account_id: "a1", name: id, folder_type, path: id, unread_count: 0, total_count: 0, is_local: false, color: "" };
}

describe("defaultFolderIds", () => {
  it("drops trash and spam and keeps everything else", () => {
    const ids = defaultFolderIds([
      folder("in", "inbox"),
      folder("out", "sent"),
      folder("arch", "archive"),
      folder("bin", "trash"),
      folder("junk", "spam"),
      folder("studio-halde", "custom"),
    ]);
    expect(ids).toEqual(["in", "out", "arch", "studio-halde"]);
  });
});

describe("buildExportLabels", () => {
  it("maps folder names and keeps the count placeholders", async () => {
    await i18n.changeLanguage("en");
    const labels = buildExportLabels(i18n.t, "en");
    expect(labels.lang).toBe("en");
    expect(labels.folderNames.inbox).toBe(i18n.t("folder.types.inbox"));
    expect(labels.accountsOne).toBe("{count} account");
    expect(labels.mailsOther).toBe("{count} mails");
    expect(labels.searchPlaceholder).toBe(i18n.t("mailExport.page.search"));
  });
});
