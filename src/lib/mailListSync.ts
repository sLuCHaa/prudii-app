/**
 * The list to render when fresh query data arrives while rows are sweeping out.
 *
 * A delete starts a ~280ms sweep on the affected rows and fires the backend call
 * at the same time. Against a local database that call and the refetch it
 * invalidates both land within a few milliseconds, so applying the new data
 * straight away unmounts those rows a tenth of the way into their tween and the
 * mails appear to blink out. Holding just them — everything else in the refetch
 * still lands — lets the sweep finish, which is what the folder-empty path
 * achieves by delaying its invalidation instead.
 *
 * Returns `fetched` itself whenever there is nothing to preserve, so the caller's
 * state update stays referentially stable.
 */
export function keepRowsLeaving<T extends { id: string }>(
  current: T[],
  fetched: T[],
  leavingIds: string[],
): T[] {
  if (leavingIds.length === 0) return fetched;

  const leaving = new Set(leavingIds);
  const landed = new Set(fetched.map((m) => m.id));
  // In `current` order, so each row below can anchor to the one above it.
  const held = current.filter((m) => leaving.has(m.id) && !landed.has(m.id));
  if (held.length === 0) return fetched;

  const out = [...fetched];
  for (const row of held) {
    const index = current.findIndex((m) => m.id === row.id);
    // Anchored to the row above it rather than to a bare index: a mail arriving
    // in the same refetch shifts every index down, which would drop the outgoing
    // row a slot and make it jump just as it starts to slide away. That anchor
    // may itself be a held row, which is why they are re-inserted top-down.
    const predecessor = index > 0 ? out.findIndex((m) => m.id === current[index - 1].id) : -1;
    out.splice(predecessor >= 0 ? predecessor + 1 : Math.min(index, out.length), 0, row);
  }
  return out;
}
