import type { QueryClient } from "@tanstack/react-query";
import i18n from "./i18n";
import { copyMailToFolder, syncFolder, trashMail } from "./tauri";
import { runMailAction, toastError } from "./errorToast";
import { invalidateMailListQueries } from "./mailQueries";
import { useAppStore } from "../stores/appStore";
import type { GuardedMail } from "./pop3Delete";
import type { Account, Folder } from "../types";

const COPIED_TOAST_MS = 10000;

/** A copy into another account. The toast offers to bin the original, which turns the copy into a move. */
export async function copyToOtherAccount(
  queryClient: QueryClient,
  mail: GuardedMail,
  dest: Folder,
  account: Pick<Account, "email">,
  guardDelete: (mails: GuardedMail[], run: () => unknown) => void,
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
    onClick: () => guardDelete([mail], () => {
      useAppStore.getState().setPendingRemoveIds([mail.id]);
      return runMailAction(() => trashMail(mail.id), {
        errorKey: "errors.trash",
        invalidate: () => invalidateMailListQueries(queryClient),
        onPendingClear: () => useAppStore.getState().setPendingRemoveIds([]),
      });
    }),
  });

  // An uploaded copy only reaches the local list through a sync; a POP3 copy is already there.
  syncFolder(dest.account_id, dest.id)
    .then(() => invalidateMailListQueries(queryClient))
    .catch((e) => console.warn("[syncFolder] after copy", dest.id, e));
}
