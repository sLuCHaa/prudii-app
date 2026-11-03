import type { Unsubscription } from "../types";

export function statusLabel(
  sub: Unsubscription,
  formatDate: (iso: string) => string,
): { key: string; options: Record<string, string | number> } {
  switch (sub.status) {
    case "waiting":
      return sub.web_pending
        ? { key: "unsubscribe.status.webPending", options: {} }
        : { key: "unsubscribe.status.waiting", options: { date: formatDate(sub.requested_at) } };
    case "quiet":
      return { key: "unsubscribe.status.quiet", options: { count: sub.quiet_days } };
    case "still_sending":
      return sub.sorted_count > 0
        ? { key: "unsubscribe.status.stillSending", options: { count: sub.sorted_count } }
        : { key: "unsubscribe.status.stillSendingSpared", options: {} };
    case "blocked":
      return { key: "unsubscribe.status.blocked", options: { count: sub.sorted_count } };
  }
}

export function statusActions(sub: Unsubscription): Array<"retry" | "allow"> {
  return sub.status === "still_sending" && sub.can_retry ? ["retry", "allow"] : ["allow"];
}
