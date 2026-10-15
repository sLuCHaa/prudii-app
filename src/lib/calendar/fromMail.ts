import type { EventDraft } from "../../types/calendar";
import { defaultDraftTimes, DEFAULT_SETTINGS } from "./format";

export function draftFromMail(mail: { subject: string; snippet: string }, now = new Date()): EventDraft {
  return {
    title: mail.subject.trim(),
    description: mail.snippet.trim(),
    times: defaultDraftTimes(now, DEFAULT_SETTINGS, false, now),
  };
}
