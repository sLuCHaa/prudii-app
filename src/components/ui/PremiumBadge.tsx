// The one premium marker used everywhere a feature is gated. Accent pill,
// translated label — replaces ad-hoc "PRO"/"Premium" spans.

import { useTranslation } from "react-i18next";

export function PremiumBadge() {
  const { t } = useTranslation();
  return (
    <span className="text-[9px] uppercase font-bold text-accent bg-accent/10 px-1.5 py-0.5 rounded whitespace-nowrap">
      {t("premium.badge")}
    </span>
  );
}
