import type { InvitationView, InviteAnswer, TimeSpan } from "../../types/calendar";

type Translate = (key: string, opts?: any) => string;

export const ANSWERS: InviteAnswer[] = ["accepted", "tentative", "declined"];

export type CardMode = "request" | "outdated" | "cancel" | "publish" | "info";

export function cardMode(v: Pick<InvitationView, "method" | "outdated" | "organizer_is_me">): CardMode {
  if (v.method === "CANCEL") return "cancel";
  if (v.method === "PUBLISH") return "publish";
  if (v.method !== "REQUEST" || v.organizer_is_me) return "info";
  return v.outdated ? "outdated" : "request";
}

export function replyMail(t: Translate, answer: InviteAnswer, title: string, comment: string | null): { subject: string; body: string } {
  const name = title.trim() || t("calendar.untitled");
  const text = t(`calendar.invite.replyBody.${answer}`, { title: name });
  const note = comment?.trim();
  return { subject: t(`calendar.invite.replySubject.${answer}`, { title: name }), body: note ? `${text}

${note}` : text };
}

/** The organizer's wall clock, only when it reads differently from the viewer's. */
export function originalTime(when: TimeSpan, tzid: string | null, systemZone: string, lang: string, use24h: boolean): string | null {
  if (when.all_day || !tzid || tzid === "UTC" || tzid === systemZone) return null;
  const opts: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hourCycle: use24h ? "h23" : "h12" };
  try {
    const there = new Intl.DateTimeFormat(lang, { ...opts, timeZone: tzid });
    const here = new Intl.DateTimeFormat(lang, { ...opts, timeZone: systemZone });
    const start = new Date(when.start);
    const end = new Date(when.end);
    if (there.format(start) === here.format(start) && there.format(end) === here.format(end)) return null;
    return `${there.format(start)} – ${there.format(end)} (${tzid})`;
  } catch {
    return null;
  }
}

const STATUS_KEYS: Record<string, string> = {
  accepted: "calendar.invite.status.accepted",
  tentative: "calendar.invite.status.tentative",
  declined: "calendar.invite.status.declined",
  "needs-action": "calendar.invite.status.needsAction",
};

export function statusKey(partstat: string | null): string | null {
  return (partstat && STATUS_KEYS[partstat]) || null;
}

export function conflictLine(t: Translate, titles: string[], count: number): string | null {
  if (count === 0) return null;
  const names = titles.map((x) => x.trim() || t("calendar.untitled")).join(", ");
  const rest = count - titles.length;
  return t("calendar.invite.conflicts", { titles: rest > 0 ? `${names} ${t("calendar.more", { count: rest })}` : names });
}
