import { Users, ExternalLink } from "lucide-react";
import { useTranslation } from "react-i18next";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useTeamSnapshot } from "../../hooks/useTeam";
import { isSnapshotFresh, memberLabel, sortRoster } from "../../lib/team";
import { GradientAvatar } from "../motion/GradientAvatar";
import type { TeamMember } from "../../types";

const TEAM_URL = "https://prudii.com/dashboard/team";

export function TeamSection({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const { snapshot, updatedAt } = useTeamSnapshot();
  if (!snapshot) return null;

  // Offline for longer than the presence ttl: the last snapshot says nothing about now.
  const fresh = isSnapshotFresh(updatedAt, Date.now());
  const roster = sortRoster(snapshot.members, snapshot.team.me).map((m) => ({ ...m, online: fresh && m.online }));
  const onlineCount = roster.filter((m) => m.online).length;

  if (collapsed) {
    return (
      <div className="mb-2 mt-1">
        <div
          className="relative flex items-center justify-center w-full py-1 rounded-md text-text-secondary"
          title={`${t("team.title")} · ${t("team.online", { count: onlineCount })}`}
        >
          <Users className="w-4 h-4" />
          {onlineCount > 0 && <span className="absolute top-0.5 right-1.5 w-1.5 h-1.5 rounded-full bg-success" />}
        </div>
      </div>
    );
  }

  return (
    <div className="mb-3">
      <div className="px-2 pt-3 pb-1.5 flex items-center gap-2">
        <div className="h-px flex-1 bg-linear-to-r from-transparent via-border to-transparent" />
        <span className="text-[11px] font-semibold uppercase tracking-widest text-text-tertiary">{t("team.title")}</span>
        <div className="h-px flex-1 bg-linear-to-r from-border via-transparent to-transparent" />
      </div>
      <div className="px-3 pb-1 text-[11px] text-text-tertiary">{t("team.online", { count: onlineCount })}</div>
      <div className="space-y-0.5">
        {roster.map((m) => (
          <MemberRow key={m.id} member={m} isMe={m.user_id === snapshot.team.me} />
        ))}
      </div>
      {snapshot.team.is_owner && (
        <button
          onClick={() => openUrl(TEAM_URL)}
          className="mt-1 flex items-center gap-1.5 px-3 py-1 text-xs text-accent hover:underline"
        >
          {t("team.manage")}
          <ExternalLink className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

function MemberRow({ member, isMe }: { member: TeamMember; isMe: boolean }) {
  const { t } = useTranslation();
  const invited = member.status === "invited";
  return (
    <div
      className={`flex items-center gap-2.5 px-3 py-1 text-sm ${invited ? "text-text-tertiary" : "text-text-secondary"}`}
      title={member.email}
    >
      <span className="relative shrink-0">
        <GradientAvatar email={member.email} name={member.name} size={22} className={invited ? "opacity-50" : ""} />
        <span
          className={`absolute -right-0.5 -bottom-0.5 w-2.5 h-2.5 rounded-full border-2 border-surface ${member.online ? "bg-success" : "bg-border"}`}
        />
      </span>
      <span className="flex-1 truncate">
        {memberLabel(member)}
        {isMe && <span className="text-text-tertiary"> · {t("team.you")}</span>}
      </span>
      {invited && <span className="text-[10px] uppercase tracking-wide text-text-tertiary">{t("team.invited")}</span>}
    </div>
  );
}
