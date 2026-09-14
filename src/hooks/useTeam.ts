import { useEffect, useMemo, useRef } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { listMailsByMessageIds, teamAssignMail, teamHeartbeat, teamListAssignments, teamSetAssignmentStatus, teamUnassign } from "../lib/tauri";
import { memberLabel, newlyAssigned } from "../lib/team";
import { toastError } from "../lib/errorToast";
import { useAppStore } from "../stores/appStore";
import type { Assignment, Mail, TeamSnapshot } from "../types";

const POLL_MS = 60_000;
const NO_ASSIGNMENTS: Assignment[] = [];

// The heartbeat doubles as the roster fetch, so one request per minute keeps
// both the server's presence record and the local snapshot current.
export function useTeamSnapshot(): { snapshot: TeamSnapshot | null; updatedAt: number } {
  const inTeamPlan = useAppStore((s) => s.licenseInfo?.plan === "team" && !!s.licenseInfo?.logged_in);
  const query = useQuery<TeamSnapshot | null>({
    queryKey: ["team-snapshot"],
    queryFn: teamHeartbeat,
    enabled: inTeamPlan,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    staleTime: 30_000,
    retry: false,
  });
  return { snapshot: inTeamPlan ? query.data ?? null : null, updatedAt: query.dataUpdatedAt };
}

export function useTeamAssignments(enabled: boolean): Assignment[] {
  const query = useQuery<Assignment[]>({
    queryKey: ["team-assignments"],
    queryFn: teamListAssignments,
    enabled,
    refetchInterval: POLL_MS,
    refetchIntervalInBackground: true,
    staleTime: 30_000,
    retry: false,
  });
  return enabled ? query.data ?? NO_ASSIGNMENTS : NO_ASSIGNMENTS;
}

function useInvalidateAssignments() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: ["team-assignments"] });
}

export function useAssignMail() {
  const invalidate = useInvalidateAssignments();
  return useMutation({
    mutationFn: (input: { messageId: string; accountEmail: string; assignedTo: string; subject: string }) =>
      teamAssignMail(input.messageId, input.accountEmail, input.assignedTo, input.subject),
    onSuccess: invalidate,
    onError: (err) => toastError(err, "errors.assign"),
  });
}

export function useSetAssignmentStatus() {
  const invalidate = useInvalidateAssignments();
  return useMutation({
    mutationFn: (input: { id: string; status: "open" | "done" }) => teamSetAssignmentStatus(input.id, input.status),
    onSuccess: invalidate,
    onError: (err) => toastError(err, "errors.assign"),
  });
}

export function useUnassignMail() {
  const invalidate = useInvalidateAssignments();
  return useMutation({
    mutationFn: (id: string) => teamUnassign(id),
    onSuccess: invalidate,
    onError: (err) => toastError(err, "errors.assign"),
  });
}

// Same infinite-query shape as the other list views, so MailList consumes it unchanged.
export function useAssignedMails(messageIds: string[], enabled: boolean) {
  const key = useMemo(() => Array.from(new Set(messageIds)).sort().join("\n"), [messageIds]);
  const ids = useMemo(() => (key ? key.split("\n") : []), [key]);
  return useInfiniteQuery<Mail[]>({
    queryKey: ["assigned-mails", key],
    queryFn: () => (ids.length ? listMailsByMessageIds(ids) : Promise.resolve([])),
    initialPageParam: 0,
    getNextPageParam: () => undefined,
    enabled,
    staleTime: 0,
  });
}

export function useTeamNotifier() {
  const { t } = useTranslation();
  const { snapshot } = useTeamSnapshot();
  const assignments = useTeamAssignments(!!snapshot);
  const prevRef = useRef<Assignment[] | null>(null);

  useEffect(() => {
    if (!snapshot) {
      prevRef.current = null;
      return;
    }
    const prev = prevRef.current;
    prevRef.current = assignments;
    if (!prev) return;
    for (const a of newlyAssigned(prev, assignments, snapshot.team.me)) {
      if (a.assigned_by === snapshot.team.me) continue;
      const by = snapshot.members.find((m) => m.user_id === a.assigned_by);
      useAppStore.getState().addToast(
        "info",
        t("team.assignedToast", { name: by ? memberLabel(by) : a.assigned_by, subject: a.subject || t("compose.noSubject") }),
      );
    }
  }, [assignments, snapshot, t]);
}
