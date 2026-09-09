import { useEffect, useRef } from "react";
import { useAttachments } from "../../hooks/useAccounts";
import { useCreateTaskFromMail } from "../../hooks/useTasks";
import { shouldAskAboutAttachments } from "../../lib/tasks";
import { MailAttachmentPickDialog } from "./MailAttachmentPickDialog";

interface CreateTaskFromMailProps {
  mailId: string;
  /** Called once the task is on its way, or the user backed out. Unmount on it. */
  onDone: () => void;
}

/**
 * Drives "turn this mail into a task" end to end: mails with real attachments
 * stop at the picker, everything else is created straight away. Entry points
 * only have to name a mail, so the three of them can't drift apart.
 *
 * A failed attachment listing is not fatal — the task is worth more than the
 * files, so it falls through to creating one without them.
 */
export function CreateTaskFromMail({ mailId, onDone }: CreateTaskFromMailProps) {
  const { data: attachments, isPending } = useAttachments(mailId);
  const createTask = useCreateTaskFromMail();

  // The mutation must fire once even though the effect below re-runs as the
  // attachment query settles.
  const started = useRef(false);
  const ask = !!attachments && shouldAskAboutAttachments(attachments);

  useEffect(() => {
    if (started.current || isPending || ask) return;
    started.current = true;
    createTask.mutate({ mailId });
    onDone();
  }, [mailId, isPending, ask]);

  if (!ask) return null;

  return (
    <MailAttachmentPickDialog
      attachments={attachments}
      onCancel={onDone}
      onConfirm={(attachmentIds) => {
        started.current = true;
        createTask.mutate({ mailId, attachmentIds });
        onDone();
      }}
    />
  );
}
