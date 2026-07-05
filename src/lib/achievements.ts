// Lightweight client-side tracking for "celebration moments". No DB schema.
// All state lives in localStorage; persistence is best-effort.

const KEY_ARCHIVED_TODAY = "prudii.archivedToday";
const KEY_STREAK         = "prudii.inboxZeroStreak";
const KEY_FIRST_HUNDRED  = "prudii.firstHundredMailsSeen";

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

interface ArchivedToday {
  date: string;
  count: number;
}

export function getArchivedToday(): number {
  try {
    const raw = localStorage.getItem(KEY_ARCHIVED_TODAY);
    if (!raw) return 0;
    const parsed = JSON.parse(raw) as ArchivedToday;
    return parsed.date === todayStr() ? parsed.count : 0;
  } catch {
    return 0;
  }
}

export function incrementArchivedToday(): number {
  const cur = getArchivedToday();
  const next: ArchivedToday = { date: todayStr(), count: cur + 1 };
  try {
    localStorage.setItem(KEY_ARCHIVED_TODAY, JSON.stringify(next));
  } catch {}
  return next.count;
}

interface Streak {
  lastDate: string;
  days: number;
}

/** Call when inbox just reached zero. Returns the (possibly incremented) streak. */
export function recordInboxZeroDay(): number {
  const today = todayStr();
  let cur: Streak = { lastDate: "", days: 0 };
  try {
    const raw = localStorage.getItem(KEY_STREAK);
    if (raw) cur = JSON.parse(raw);
  } catch {}

  if (cur.lastDate === today) return cur.days;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().slice(0, 10);

  const next: Streak = {
    lastDate: today,
    days: cur.lastDate === yesterdayStr ? cur.days + 1 : 1,
  };
  try {
    localStorage.setItem(KEY_STREAK, JSON.stringify(next));
  } catch {}
  return next.days;
}

export function getInboxZeroStreak(): number {
  try {
    const raw = localStorage.getItem(KEY_STREAK);
    if (!raw) return 0;
    const cur = JSON.parse(raw) as Streak;
    return cur.lastDate === todayStr() ? cur.days : 0;
  } catch {
    return 0;
  }
}

export function checkFirstHundredOnce(): boolean {
  try {
    if (localStorage.getItem(KEY_FIRST_HUNDRED) === "1") return false;
    localStorage.setItem(KEY_FIRST_HUNDRED, "1");
    return true;
  } catch {
    return false;
  }
}
