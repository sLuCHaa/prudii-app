/**
 * Snooze targets, shared by the row's snooze button and the mail context menu so
 * the two can't drift apart in either the options they offer or the instant they
 * mean.
 */

export interface SnoozePreset {
  id: string;
  labelKey: string;
  /** Never mutates `now`. */
  at: (now: Date) => Date;
}

/**
 * The wire format for `snoozed_until`.
 *
 * UTC, not local: the mail lists hide a snoozed mail with
 * `snoozed_until <= datetime('now')`, and SQLite's `now` is UTC. Formatting from
 * local getters would shift every snooze by the user's offset — hiding mails too
 * long east of Greenwich and un-hiding them early to the west.
 */
export function toSnoozeStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

const shifted = (now: Date, apply: (d: Date) => void): Date => {
  const d = new Date(now.getTime());
  apply(d);
  return d;
};

export const SNOOZE_PRESETS: SnoozePreset[] = [
  {
    id: "in1Hour",
    labelKey: "snooze.in1Hour",
    at: (now) => shifted(now, (d) => d.setHours(d.getHours() + 1)),
  },
  {
    id: "in3Hours",
    labelKey: "snooze.in3Hours",
    at: (now) => shifted(now, (d) => d.setHours(d.getHours() + 3)),
  },
  {
    id: "tomorrowMorning",
    labelKey: "snooze.tomorrowMorning",
    // 9am in the user's own day, so this one is deliberately local before it is
    // stamped to UTC.
    at: (now) => shifted(now, (d) => {
      d.setDate(d.getDate() + 1);
      d.setHours(9, 0, 0, 0);
    }),
  },
  {
    id: "nextMonday",
    labelKey: "snooze.nextMonday",
    at: (now) => shifted(now, (d) => {
      // On a Monday this must mean the *next* one, never today.
      const weekday = d.getDay();
      d.setDate(d.getDate() + (weekday === 0 ? 1 : 8 - weekday));
      d.setHours(9, 0, 0, 0);
    }),
  },
];
