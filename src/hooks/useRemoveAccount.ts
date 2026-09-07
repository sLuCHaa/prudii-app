import { useTranslation } from "react-i18next";
import { useAppStore } from "../stores/appStore";
import { useDeleteAccount } from "./useAccounts";
import { useDialog } from "../components/ui/DialogProvider";

/** Confirmation dialog + mutation + store cleanup, shared by the settings accounts list and the sidebar account menu. */
export function useRemoveAccount() {
  const { t } = useTranslation();
  const dialog = useDialog();
  const deleteAccount = useDeleteAccount();

  return async function removeAccount(accountId: string) {
    const confirmed = await dialog.danger({
      title: t("settings.deleteAccountConfirm.title"),
      message: t("settings.deleteAccountConfirm.body"),
      confirmLabel: t("settings.deleteAccountConfirm.confirm"),
      cancelLabel: t("settings.deleteAccountConfirm.cancel"),
    });
    if (!confirmed) return;
    deleteAccount.mutate(accountId, {
      onSuccess: () => {
        // Immediately remove account from Zustand store so Sidebar updates
        const store = useAppStore.getState();
        store.setAccounts(store.accounts.filter((a) => a.id !== accountId));
        if (store.selectedAccountId === accountId) {
          store.setSelectedAccountId(null);
          store.setSelectedFolderId(null);
          store.setSelectedMailId(null);
        }
      },
    });
  };
}
