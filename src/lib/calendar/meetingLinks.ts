// Keep in step with src-tauri/src/calendar/meeting.rs (the reminder toast's Join button).
const MEETING_HOSTS = ["teams.microsoft.com", "teams.live.com", "zoom.us", "meet.google.com", "webex.com", "whereby.com", "meet.jit.si"];
const URL_RE = /https?:\/\/[^\s<>"'()]+/g;

function trimUrl(raw: string): string {
  return raw.replace(/[.,;:!?\]]+$/, "");
}

export function findMeetingLink(...texts: (string | null | undefined)[]): string | null {
  for (const text of texts) {
    for (const match of (text ?? "").matchAll(URL_RE)) {
      const url = trimUrl(match[0]);
      if (!url.startsWith("https://")) continue;
      let host: string;
      try {
        host = new URL(url).hostname.toLowerCase();
      } catch {
        continue;
      }
      if (MEETING_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) return url;
    }
  }
  return null;
}

export type TextPart = { kind: "text"; text: string } | { kind: "link"; text: string; href: string };

export function linkify(text: string): TextPart[] {
  const parts: TextPart[] = [];
  let last = 0;
  for (const match of text.matchAll(URL_RE)) {
    const url = trimUrl(match[0]);
    const index = match.index ?? 0;
    if (index > last) parts.push({ kind: "text", text: text.slice(last, index) });
    parts.push({ kind: "link", text: url, href: url });
    last = index + url.length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}
