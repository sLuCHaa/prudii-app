import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useDialog } from "../components/ui/DialogProvider";
import { confirmMailDelete, deletesOnPop3Server } from "../lib/pop3Delete";

/** Runs a delete at once, or only after the user accepted that the POP3 server copy goes too. */
export function useMailDeleteGuard() {
  const { danger } = useDialog();
  const { t } = useTranslation();
  return useCallback(
    (mailIds: string[], run: () => void) => {
      if (!deletesOnPop3Server()) {
        run();
        return;
      }
      void confirmMailDelete(danger, t, mailIds).then((ok) => {
        if (ok) run();
      });
    },
    [danger, t],
  );
}
