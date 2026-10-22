export const SEEN_KEY = "prudii-whats-new-seen";

export type WhatsNewIcon = "calendar" | "mail" | "rss" | "tasks" | "sparkles" | "image" | "type";
export type WhatsNewTone = "blue" | "green" | "amber" | "violet";

export interface WhatsNewItem {
  icon: WhatsNewIcon;
  tone: WhatsNewTone;
  /** Texts live under `${key}.title` and `${key}.text`. */
  key: string;
}

export interface WhatsNewRelease {
  version: string;
  items: WhatsNewItem[];
}

export const RELEASES: WhatsNewRelease[] = [
  {
    version: "1.8.0",
    items: [
      { icon: "sparkles", tone: "blue", key: "whatsNew.v1_8_0.look" },
      { icon: "mail", tone: "green", key: "whatsNew.v1_8_0.recipients" },
    ],
  },
  {
    version: "1.7.3",
    items: [
      { icon: "image", tone: "green", key: "whatsNew.v1_7_3.images" },
      { icon: "sparkles", tone: "blue", key: "whatsNew.v1_7_3.signature" },
      { icon: "type", tone: "violet", key: "whatsNew.v1_7_3.font" },
      { icon: "mail", tone: "amber", key: "whatsNew.v1_7_3.typos" },
      { icon: "calendar", tone: "blue", key: "whatsNew.v1_7_0.calendar" },
    ],
  },
  {
    version: "1.7.1",
    items: [
      { icon: "sparkles", tone: "green", key: "whatsNew.v1_7_1.look" },
      { icon: "calendar", tone: "blue", key: "whatsNew.v1_7_0.calendar" },
      { icon: "rss", tone: "amber", key: "whatsNew.v1_7_0.subscriptions" },
      { icon: "tasks", tone: "violet", key: "whatsNew.v1_7_0.tasks" },
    ],
  },
  {
    version: "1.7.0",
    items: [
      { icon: "calendar", tone: "blue", key: "whatsNew.v1_7_0.calendar" },
      { icon: "rss", tone: "amber", key: "whatsNew.v1_7_0.subscriptions" },
      { icon: "tasks", tone: "violet", key: "whatsNew.v1_7_0.tasks" },
    ],
  },
];

function parseVersion(v: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(v.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null;
}

export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a) ?? [0, 0, 0];
  const pb = parseVersion(b) ?? [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

export function displayVersion(version: string): string {
  const p = parseVersion(version);
  return p ? `${p[0]}.${p[1]}` : version;
}

export function readSeen(store: Pick<Storage, "getItem"> | null): string | null | undefined {
  if (!store) return undefined;
  try {
    return store.getItem(SEEN_KEY);
  } catch {
    return undefined;
  }
}

/** Unreadable storage shows nothing, so a blocked store cannot bring the window back on every start. */
export function pendingRelease(
  current: string,
  seen: string | null | undefined,
  hasAccounts: boolean,
  releases: WhatsNewRelease[],
): { release: WhatsNewRelease | null; store: string | null } {
  if (seen === undefined) return { release: null, store: null };
  const known = seen !== null && parseVersion(seen) ? seen : null;
  if (known && compareVersions(known, current) >= 0) return { release: null, store: null };
  if (!hasAccounts) return { release: null, store: current };
  const candidates = releases.filter(
    (r) => (known === null || compareVersions(r.version, known) > 0) && compareVersions(r.version, current) <= 0,
  );
  const newest = candidates.reduce<WhatsNewRelease | null>(
    (best, r) => (!best || compareVersions(r.version, best.version) > 0 ? r : best),
    null,
  );
  return newest ? { release: newest, store: null } : { release: null, store: current };
}
