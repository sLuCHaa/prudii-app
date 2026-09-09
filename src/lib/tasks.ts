import type { Attachment, Task, TaskStatus } from "../types";
import { TASK_STATUSES } from "../types";

/**
 * Whether turning this mail into a task should stop to ask about its files.
 *
 * Only real attachments count. A mail whose sole "attachments" are the cid:
 * images of a signature is, to the user, a mail without attachments — asking
 * about it would be noise on nearly every reply.
 */
export function shouldAskAboutAttachments(attachments: Attachment[]): boolean {
  return attachments.some((a) => !a.is_inline);
}

/**
 * The attachments the picker offers, real ones first. Inline images stay on the
 * list — a mail can carry its actual content that way — but are never
 * pre-selected, so signature logos don't ride along by default.
 */
export function attachmentPickOrder(attachments: Attachment[]): Attachment[] {
  return [...attachments].sort((a, b) => Number(a.is_inline) - Number(b.is_inline));
}

/** Ids ticked when the picker opens. */
export function defaultPickedAttachmentIds(attachments: Attachment[]): string[] {
  return attachments.filter((a) => !a.is_inline).map((a) => a.id);
}

export function isOverdue(task: Pick<Task, "due_at" | "status">, now: Date): boolean {
  if (!task.due_at || task.status === "done") return false;
  return new Date(task.due_at).getTime() < now.getTime();
}

export function isDueToday(task: Pick<Task, "due_at">, now: Date): boolean {
  if (!task.due_at) return false;
  const d = new Date(task.due_at);
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
}

/** ISO-UTC due date -> the local value an `<input type="datetime-local">` expects. */
export function toDatetimeLocalValue(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The reverse of `toDatetimeLocalValue` — reads the input's local value as local time, returns ISO-UTC. */
export function fromDatetimeLocalValue(value: string): string {
  return new Date(value).toISOString();
}

// Mirrors parseQuickAdd's times for bare "heute"/"morgen" so both entry paths agree.
export function quickDueDate(kind: "today" | "tomorrow" | "nextWeek", now: Date): string {
  const at = (daysFromNow: number, hour: number) =>
    new Date(now.getFullYear(), now.getMonth(), now.getDate() + daysFromNow, hour, 0).toISOString();
  switch (kind) {
    case "today": return at(0, 18);
    case "tomorrow": return at(1, 9);
    case "nextWeek": return at(7, 9);
  }
}

export function groupByStatus(tasks: Task[]): Record<TaskStatus, Task[]> {
  const grouped = { open: [], in_progress: [], done: [] } as Record<TaskStatus, Task[]>;
  for (const task of tasks) {
    grouped[task.status].push(task);
  }
  for (const status of TASK_STATUSES) {
    grouped[status].sort((a, b) => a.sort_order - b.sort_order);
  }
  return grouped;
}

/**
 * Board drops are computed against the visible (possibly filtered) column, while
 * `move_task` inserts among all tasks of that status — so anchor on the visible
 * predecessor to translate the one index into the other.
 */
export function fullColumnDropIndex(allTasks: Task[], status: TaskStatus, movingId: string, visibleColumn: Task[]): number {
  const column = allTasks
    .filter((task) => task.status === status && task.id !== movingId)
    .sort((a, b) => a.sort_order - b.sort_order);
  const visibleIndex = visibleColumn.findIndex((task) => task.id === movingId);
  if (visibleIndex < 0) return column.length;
  if (visibleIndex === 0) return 0;
  const predecessorId = visibleColumn[visibleIndex - 1].id;
  const at = column.findIndex((task) => task.id === predecessorId);
  return at >= 0 ? at + 1 : column.length;
}

// JS `\b` only treats [A-Za-z0-9_] as word characters, so it fails to bound a word
// starting with an umlaut (e.g. "übermorgen" right after a space). Build boundaries
// from an explicit charset that includes German letters instead.
const WORD_CHARS = "A-Za-z0-9_äöüÄÖÜß";
function wordRe(pattern: string, flags = "i"): RegExp {
  return new RegExp(`(?<![${WORD_CHARS}])(?:${pattern})(?![${WORD_CHARS}])`, flags);
}

const WEEKDAYS_FULL: Record<string, number> = {
  montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonntag: 0,
  monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6, sunday: 0,
};

const WEEKDAYS_SHORT: Record<string, number> = {
  mo: 1, di: 2, mi: 3, do: 4, fr: 5, sa: 6, so: 0,
  mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, sun: 0,
};

// Requiring a colon or an am/pm/uhr suffix keeps a bare number in a title
// (e.g. "Kunde 9") from ever being read as a time.
const TIME_PATTERN = "\\b(\\d{1,2}):(\\d{2})\\s*(am|pm)?\\b|\\b(\\d{1,2})\\s*(am|pm|uhr)\\b";
const TIME_RE = new RegExp(TIME_PATTERN, "i");
const TIME_START_RE = new RegExp(`^(?:${TIME_PATTERN})`, "i");

function to12HourAdjusted(hour: number, meridiem: string | undefined): number {
  if (meridiem === "pm" && hour < 12) return hour + 12;
  if (meridiem === "am" && hour === 12) return 0;
  return hour;
}

// Strictly-future next occurrence of `target` weekday (0=Sun..6=Sat) — "today" never counts.
function nextWeekday(from: Date, target: number): Date {
  let delta = (target - from.getDay() + 7) % 7;
  if (delta === 0) delta = 7;
  return new Date(from.getFullYear(), from.getMonth(), from.getDate() + delta);
}

/// Parses natural-language date/time hints out of a quick-add title (de + en) and
/// returns the cleaned title plus an ISO-UTC due date, or null when nothing matched.
export function parseQuickAdd(input: string, now: Date): { title: string; dueAt: string | null } {
  let text = input;
  let year = now.getFullYear();
  let month = now.getMonth();
  let day = now.getDate();
  let hour: number | null = null;
  let minute = 0;
  let dateSet = false;

  function consume(re: RegExp): RegExpMatchArray | null {
    const m = re.exec(text);
    if (m) text = text.slice(0, m.index) + text.slice(m.index! + m[0].length);
    return m;
  }

  function setDate(d: Date, h: number) {
    year = d.getFullYear();
    month = d.getMonth();
    day = d.getDate();
    hour = h;
    minute = 0;
    dateSet = true;
  }

  let m = consume(wordRe("in\\s+(\\d+)\\s+(?:tagen|days)"));
  if (m) setDate(new Date(year, month, day + parseInt(m[1], 10)), 9);

  if (!dateSet) {
    m = consume(wordRe("in\\s+(\\d+)\\s+(?:wochen|weeks)"));
    if (m) setDate(new Date(year, month, day + parseInt(m[1], 10) * 7), 9);
  }

  if (!dateSet) {
    m = consume(wordRe("übermorgen"));
    if (m) setDate(new Date(year, month, day + 2), 9);
  }

  if (!dateSet) {
    m = consume(wordRe("morgen|tomorrow"));
    if (m) setDate(new Date(year, month, day + 1), 9);
  }

  if (!dateSet) {
    m = consume(wordRe("heute|today"));
    if (m) setDate(new Date(year, month, day), 18);
  }

  if (!dateSet) {
    const fullRe = wordRe(`(${Object.keys(WEEKDAYS_FULL).join("|")})`);
    m = consume(fullRe);
    if (m) setDate(nextWeekday(now, WEEKDAYS_FULL[m[1].toLowerCase()]), 9);
  }

  // Short weekday tokens (mo/di/.../sun) double as ordinary words, so they only
  // count as a date token when nothing but a time token follows them.
  if (!dateSet) {
    const shortRe = wordRe(`(${Object.keys(WEEKDAYS_SHORT).join("|")})`, "gi");
    let candidate: RegExpExecArray | null;
    while ((candidate = shortRe.exec(text)) !== null) {
      const after = text.slice(candidate.index + candidate[0].length).trim();
      if (after.length === 0 || TIME_START_RE.test(after)) {
        text = text.slice(0, candidate.index) + text.slice(candidate.index + candidate[0].length);
        setDate(nextWeekday(now, WEEKDAYS_SHORT[candidate[1].toLowerCase()]), 9);
        break;
      }
    }
  }

  const timeMatch = consume(TIME_RE);
  if (timeMatch) {
    if (timeMatch[1] !== undefined) {
      hour = to12HourAdjusted(parseInt(timeMatch[1], 10), timeMatch[3]?.toLowerCase());
      minute = parseInt(timeMatch[2], 10);
    } else {
      const suffix = timeMatch[5].toLowerCase();
      hour = suffix === "uhr" ? parseInt(timeMatch[4], 10) : to12HourAdjusted(parseInt(timeMatch[4], 10), suffix);
      minute = 0;
    }
    if (!dateSet) {
      // No date token: today, unless that time has already passed — then tomorrow.
      const candidate = new Date(year, month, day, hour, minute);
      if (candidate.getTime() <= now.getTime()) {
        const d = new Date(year, month, day + 1);
        year = d.getFullYear();
        month = d.getMonth();
        day = d.getDate();
      }
      dateSet = true;
    }
  }

  // Stripping a trailing token often leaves dangling punctuation ("Sachen erledigen, do" → "Sachen erledigen,").
  const title = text.replace(/\s+/g, " ").trim().replace(/[,;:-]+$/, "").trim();
  if (hour === null) return { title, dueAt: null };
  return { title, dueAt: new Date(year, month, day, hour, minute).toISOString() };
}

/** Splits mail ids into batches so one long mail list never becomes a single oversized query. */
export function chunkIds(ids: string[], size: number): string[][] {
  if (ids.length === 0) return [];
  if (size < 1) return [ids];
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

/** Folds the per-chunk link counts of `tasks_for_mails` back into one map. */
export function mergeCounts(chunks: Record<string, number>[]): Record<string, number> {
  const merged: Record<string, number> = {};
  for (const chunk of chunks) {
    for (const id of Object.keys(chunk)) merged[id] = chunk[id];
  }
  return merged;
}
