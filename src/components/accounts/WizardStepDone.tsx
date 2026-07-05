import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { motion } from "motion/react";
import { CelebrationConfetti } from "../motion/CelebrationConfetti";
import { GradientAvatar } from "../motion/GradientAvatar";
import { SpringCard } from "../motion/SpringCard";
import { NumberTween } from "../motion/NumberTween";
import { SPRING_CELEBRATE } from "../motion/tokens";

interface WizardStepDoneProps {
  email: string;
  name?: string;
  mailCount: number;
  folderCount: number;
  showOnboarding: boolean;
  onClose: () => void;
}

export function WizardStepDone({
  email,
  name,
  mailCount,
  folderCount,
  showOnboarding,
  onClose,
}: WizardStepDoneProps) {
  const { t } = useTranslation();
  const [confetti, setConfetti] = useState(0);

  useEffect(() => {
    setConfetti(1);
  }, []);

  return (
    <div className="relative flex flex-col items-center justify-center py-10 px-8 text-center">
      <CelebrationConfetti trigger={confetti} count={50} originX={0.5} originY={0.2} />

      <motion.div
        initial={{ scale: 0.6, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        transition={SPRING_CELEBRATE}
      >
        <GradientAvatar email={email} name={name} size={96} ring />
      </motion.div>

      <motion.h2
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ ...SPRING_CELEBRATE, delay: 0.15 }}
        className="mt-6 text-2xl font-heading font-bold"
      >
        {t("wizard.doneTitle")}
      </motion.h2>

      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ ...SPRING_CELEBRATE, delay: 0.25 }}
        className="mt-2 text-sm text-text-secondary"
      >
        {email}
      </motion.div>

      <motion.div
        initial={{ y: 12, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ ...SPRING_CELEBRATE, delay: 0.35 }}
        className="mt-6 flex items-center gap-6 text-sm"
      >
        <div className="flex flex-col items-center">
          <span className="text-2xl font-bold font-heading">
            <NumberTween from={0} to={mailCount} duration={800} />
          </span>
          <span className="text-text-tertiary">{t("wizard.mails")}</span>
        </div>
        <div className="w-px h-8 bg-border" />
        <div className="flex flex-col items-center">
          <span className="text-2xl font-bold font-heading">
            <NumberTween from={0} to={folderCount} duration={800} />
          </span>
          <span className="text-text-tertiary">{t("wizard.folders")}</span>
        </div>
      </motion.div>

      <motion.div
        initial={{ y: 16, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ ...SPRING_CELEBRATE, delay: 0.5 }}
        className="mt-8"
      >
        <SpringCard glow lift={4} onClick={onClose} className="px-6 py-3 inline-block">
          <span className="font-semibold">{t("wizard.cta")}</span>
        </SpringCard>
      </motion.div>

      {showOnboarding && (
        <motion.div
          initial={{ y: 12, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          transition={{ ...SPRING_CELEBRATE, delay: 0.65 }}
          className="mt-6 p-3 rounded-lg bg-bg-secondary border border-border text-left w-full"
        >
          <p className="text-xs font-semibold text-text mb-1.5">{t("onboarding.welcomeTitle")}</p>
          <ul className="text-xs text-text-secondary space-y-1">
            <li className="flex items-center gap-2">
              <kbd className="px-1.5 py-0.5 bg-bg border border-border rounded text-[10px]">?</kbd>
              <span>{t("onboarding.tipShortcuts")}</span>
            </li>
            <li className="flex items-center gap-2">
              <kbd className="px-1.5 py-0.5 bg-bg border border-border rounded text-[10px]">Ctrl+K</kbd>
              <span>{t("onboarding.tipCommandPalette")}</span>
            </li>
            <li className="flex items-center gap-2">
              <kbd className="px-1.5 py-0.5 bg-bg border border-border rounded text-[10px]">c</kbd>
              <span>{t("onboarding.tipCompose")}</span>
            </li>
          </ul>
        </motion.div>
      )}
    </div>
  );
}
