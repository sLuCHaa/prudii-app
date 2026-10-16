import { useTranslation } from "react-i18next";
import type { EditScope, EventTimes, Occurrence } from "../../types/calendar";
import { useDeleteEvent, useMoveOccurrence } from "../../hooks/useCalendar";
import { useDialog } from "../ui/DialogProvider";
import { useScopePrompt } from "./RecurrenceScopeDialog";

/** Delete and move with the scope question for recurring events; render `dialogs` once. */
export function useEventActions() {
  const { t } = useTranslation();
  const dialog = useDialog();
  const scope = useScopePrompt();
  const del = useDeleteEvent();
  const move = useMoveOccurrence();

  async function deleteOccurrence(o: Occurrence): Promise<boolean> {
    if (o.read_only) return false;
    let chosen: EditScope | null = "all";
    if (o.is_recurring) {
      chosen = await scope.prompt("delete");
    } else {
      const ok = await dialog.danger({
        title: t("calendar.deleteTitle"),
        message: t("calendar.deleteMessage", { title: o.title || t("calendar.untitled") }),
        confirmLabel: t("calendar.delete"),
      });
      if (!ok) chosen = null;
    }
    if (!chosen) return false;
    try {
      await del.mutateAsync({ id: o.event_id, occurrenceKey: o.occurrence_key, scope: chosen });
      return true;
    } catch {
      return false;
    }
  }

  async function moveOccurrence(o: Occurrence, times: EventTimes): Promise<void> {
    if (o.read_only) return;
    const chosen = o.is_recurring ? await scope.prompt("edit") : "all";
    if (!chosen) return;
    move.mutate({ id: o.event_id, occurrenceKey: o.occurrence_key, times, scope: chosen });
  }

  return { deleteOccurrence, moveOccurrence, promptScope: scope.prompt, dialogs: scope.element };
}
