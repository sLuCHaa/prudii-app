import { describe, it, expect } from "vitest";
import i18n from "./i18n";
import de from "../locales/de.json";
import ru from "../locales/ru.json";
import { defaultFolderIds, buildExportLabels, exportResultMessage } from "./mailExport";
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
    expect(labels.mailsFew).toBe("");
    expect(labels.showMore).toBe(i18n.t("mailExport.page.showMore"));
  });

  it("passes the extra Russian plural forms", async () => {
    i18n.addResourceBundle("ru", "translation", ru, true, true);
    await i18n.changeLanguage("ru");
    const labels = buildExportLabels(i18n.t, "ru");
    expect(labels.mailsFew).toBe("{count} письма");
    expect(labels.mailsMany).toBe("{count} писем");
    expect(labels.accountsFew).toBe("{count} аккаунта");
    expect(labels.accountsMany).toBe("{count} аккаунтов");
    await i18n.changeLanguage("en");
  });
});

describe("exportResultMessage", () => {
  const summary = (exported: number, localCopy: number, failed: number) => ({ path: "x", exported, localCopy, failed, cancelled: false });

  it("uses singular and plural forms", async () => {
    i18n.addResourceBundle("de", "translation", de, true, true);
    await i18n.changeLanguage("de");
    expect(exportResultMessage(i18n.t, summary(1, 0, 1))).toBe("1 Mail exportiert. 1 konnte nicht exportiert werden.");
    expect(exportResultMessage(i18n.t, summary(98, 1, 2))).toBe("99 Mails exportiert. 1 aus lokaler Kopie, kein Original. 2 konnten nicht exportiert werden.");
    await i18n.changeLanguage("en");
    expect(exportResultMessage(i18n.t, summary(1, 0, 0))).toBe("1 mail exported.");
    i18n.addResourceBundle("ru", "translation", ru, true, true);
    await i18n.changeLanguage("ru");
    expect(exportResultMessage(i18n.t, summary(2, 0, 5))).toBe("2 письма экспортировано. 5 писем не удалось экспортировать.");
    expect(exportResultMessage(i18n.t, summary(21, 0, 0))).toBe("21 письмо экспортировано.");
    await i18n.changeLanguage("en");
  });
});
