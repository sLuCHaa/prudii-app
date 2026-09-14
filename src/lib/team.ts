import type { Assignment, TeamMember } from "../types";

export const PRESENCE_TTL_MS = 180_000;

export function memberLabel(m: TeamMember): string {
  return m.name || m.email.split("@")[0] || m.email;
}

export function sortRoster(members: TeamMember[], meId: string): TeamMember[] {
  return [...members].sort((x, y) => {
    if (x.user_id === meId) return -1;
    if (y.user_id === meId) return 1;
    if (x.online !== y.online) return x.online ? -1 : 1;
    return memberLabel(x).localeCompare(memberLabel(y));
  });
}

export function indexAssignments(list: Assignment[]): Map<string, Assignment> {
  return new Map(list.map((a) => [a.message_id, a]));
}

export function openAssignedTo(list: Assignment[], meId: string): Assignment[] {
  return list.filter((a) => a.assigned_to === meId && a.status === "open");
}

export function newlyAssigned(prev: Assignment[], next: Assignment[], meId: string): Assignment[] {
  const before = new Set(prev.filter((a) => a.assigned_to === meId).map((a) => a.id));
  return openAssignedTo(next, meId).filter((a) => !before.has(a.id));
}

// A snapshot older than the presence ttl says nothing about who is online now.
export function isSnapshotFresh(updatedAt: number, now: number, ttlMs = PRESENCE_TTL_MS): boolean {
  return updatedAt > 0 && now - updatedAt <= ttlMs;
}
