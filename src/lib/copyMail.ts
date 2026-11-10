import type { QueryClient } from "@tanstack/react-query";
import i18n from "./i18n";
import { copyMailToFolder, syncFolder, trashMail } from "./tauri";
import { runMailAction, toastError } from "./errorToast";
import { invalidateMailListQueries } from "./mailQueries";
import { useAppStore } from "../stores/appStore";
import type { Account, Folder, Mail } from "../types";

const COPIED_TOAST_MS = 10000;

/** A copy into another account. The toast offers to bin the original, which turns the copy into a move. */
export async function copyToOtherAccount(
  queryClient: QueryClient,
  mail: Pick<Mail, "id">,
  dest: Folder,
  account: Pick<Account, "email">,
): Promise<void> {
  try {
    await copyMailToFolder(mail.id, dest.id);
  } catch (e) {
    toastError(e, "errors.copy");
    return;
  }

  const folder = i18n.t(`folder.types.${dest.folder_type}`, { defaultValue: dest.name });
  useAppStore.getState().addToast("success", i18n.t("folder.copied", { folder }), account.email, COPIED_TOAST_MS, {
    label: i18n.t("folder.trashOriginal"),
    onClick: () => {
      useAppStore.getState().setPendingRemoveIds([mail.id]);
      void runMailAction(() => trashMail(mail.id), {
        errorKey: "errors.trash",
        invalidate: () => invalidateMailListQueries(queryClient),
        onPendingClear: () => useAppStore.getState().setPendingRemoveIds([]),
      });
    },
  });

  // The upload went straight to the server; only a sync brings the copy into the local list.
  syncFolder(dest.account_id, dest.id)
    .then(() => invalidateMailListQueries(queryClient))
    .catch((e) => console.warn("[syncFolder] after copy", dest.id, e));
}
