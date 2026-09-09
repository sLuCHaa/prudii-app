/**
 * How many compose windows may be open at once. Past this the app refuses to
 * open another and surfaces the oldest one instead — an unbounded pile of
 * drafts is easy to produce by accident and impossible to keep track of.
 */
export const MAX_COMPOSE_WINDOWS = 5;

// Mirrors the label openComposeWindow builds: `compose-<epoch ms>-<counter>`.
const COMPOSE_LABEL = /^compose-(\d+)-(\d+)$/;

/** Narrows a list of window labels to the compose windows among them. */
export function composeLabels(labels: string[]): string[] {
  return labels.filter((label) => COMPOSE_LABEL.test(label));
}

/**
 * The compose window opened first, or null if none are open.
 *
 * Sorted numerically: the labels' timestamps have different digit counts, so
 * plain string ordering would call the wrong window the oldest. The counter
 * only breaks ties, since a main-window reload resets it to zero.
 */
export function oldestComposeLabel(labels: string[]): string | null {
  const parsed = composeLabels(labels)
    .map((label) => {
      const [, at, counter] = COMPOSE_LABEL.exec(label)!;
      return { label, at: Number(at), counter: Number(counter) };
    })
    .sort((a, b) => a.at - b.at || a.counter - b.counter);
  return parsed[0]?.label ?? null;
}
