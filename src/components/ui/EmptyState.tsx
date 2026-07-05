import { useEffect, useRef } from "react";
import { Inbox } from "lucide-react";
import gsap from "gsap";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { NumberTween } from "../motion/NumberTween";
import { SPRING_BOUNCY } from "../motion/tokens";
import { getArchivedToday, getInboxZeroStreak } from "../../lib/achievements";
import { DaylightSky, useAtmosphereLine } from "../motion/DaylightSky";
import { countSearchableMails } from "../../lib/tauri";

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
  className?: string;
}

export function EmptyState({ icon, title, description, action, className = "" }: EmptyStateProps) {
  const iconRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const descRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const els = [iconRef.current, titleRef.current, descRef.current].filter(Boolean) as HTMLElement[];

    els.forEach((el, i) => {
      gsap.fromTo(el,
        { opacity: 0, y: 16, scale: 0.8 },
        { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "back.out(1.5)", delay: i * 0.15 }
      );
    });

    return () => {
      els.forEach((el) => gsap.killTweensOf(el));
    };
  }, []);

  return (
    <div className={`flex flex-col items-center justify-center h-full text-center px-6 py-12 max-w-sm mx-auto ${className}`}>
      <div ref={iconRef} className="mb-4 w-12 h-12 rounded-full bg-bg-secondary/70 backdrop-blur-sm flex items-center justify-center text-text-tertiary" style={{ opacity: 0 }}>
        {icon || <Inbox className="w-6 h-6" />}
      </div>
      <h3 ref={titleRef} className="font-heading text-lg font-semibold text-text mb-1" style={{ opacity: 0 }}>{title}</h3>
      {description && (
        <p ref={descRef} className="text-sm text-text-secondary leading-relaxed mb-4" style={{ opacity: 0 }}>{description}</p>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function InboxZeroState() {
  const { t } = useTranslation();
  const archived = getArchivedToday();
  const streak = getInboxZeroStreak();
  const line = useAtmosphereLine("inboxZero");

  return (
    <div className="relative flex-1 min-h-[320px] overflow-hidden">
      <DaylightSky />
      <div className="relative z-10 flex flex-col items-center justify-center text-center h-full py-16 px-6">
        <motion.div
          initial={{ scale: 0.6, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          transition={SPRING_BOUNCY}
          className="text-6xl mb-4"
        >
          🌱
        </motion.div>
        <h2 className="text-xl font-heading font-bold">{t("emptyState.inboxZeroTitle")}</h2>
        <p className="text-sm text-text-secondary mt-2">{line ?? t("emptyState.inboxZeroDesc")}</p>
        {archived > 0 && (
          <div className="mt-6 inline-flex items-center gap-2 px-4 py-2 rounded-full bg-success/10 text-success">
            <span className="text-lg font-bold">
              <NumberTween from={0} to={archived} duration={500} />
            </span>
            <span className="text-xs">{t("emptyState.archivedToday")}</span>
          </div>
        )}
        {streak > 1 && (
          <div className="mt-3 text-xs text-warning font-semibold">
            🔥 {t("emptyState.streak", { days: streak })}
          </div>
        )}
      </div>
    </div>
  );
}

export function NoSearchResultsState({ query }: { query: string }) {
  const { t, i18n } = useTranslation();
  const { data: total } = useQuery({
    queryKey: ["searchable-mail-count"],
    queryFn: () => countSearchableMails(),
    staleTime: 60_000,
  });

  // Only show the count line when it reads naturally (>= 2 mails); while
  // loading or on error, fall back to the existing generic description.
  const description =
    total !== undefined && total >= 2
      ? t("emptyState.noResultsSearchedCount", { formatted: total.toLocaleString(i18n.language) })
      : t("emptyState.noResultsDesc");

  return (
    <EmptyState
      icon={<span className="text-2xl">🔍</span>}
      title={t("emptyState.noResultsTitle", { query })}
      description={description}
    />
  );
}
