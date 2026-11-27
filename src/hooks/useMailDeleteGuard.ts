import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useDialog } from "../components/ui/DialogProvider";
import { confirmMailDelete, mayDeleteOnPop3Server, withDeleteLock, type GuardedMail } from "../lib/pop3Delete";

/** Runs a delete at once, or only after the user accepted that the POP3 server copy goes too. */
export function useMailDeleteGuard() {
  const { danger } = useDialog();
  const { t } = useTranslation();
  return useCallback(
    (mails: GuardedMail[], run: () => unknown) => {
      if (!mayDeleteOnPop3Server(mails)) {
        run();
        return;
      }
      void withDeleteLock(mails, async () => {
        if (await confirmMailDelete(danger, t, mails)) await run();
      });
    },
    [danger, t],
  );
}
