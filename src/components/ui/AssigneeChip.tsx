import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";
import { GradientAvatar } from "../motion/GradientAvatar";
import { Tooltip } from "./Tooltip";
import { memberLabel } from "../../lib/team";
import type { TeamMember } from "../../types";

export function AssigneeChip({ member, done }: { member: TeamMember | undefined; done: boolean }) {
  const { t } = useTranslation();
  const name = member ? memberLabel(member) : "?";
  return (
    <Tooltip label={t(done ? "team.assignedDone" : "team.assignedTo", { name })}>
      <span className="relative inline-flex shrink-0" aria-label={name}>
        <GradientAvatar email={member?.email ?? "?"} name={member?.name ?? ""} size={16} className={done ? "opacity-50" : ""} />
        {done && <Check className="absolute -right-1 -bottom-1 w-2.5 h-2.5 text-success" strokeWidth={3} />}
      </span>
    </Tooltip>
  );
}
