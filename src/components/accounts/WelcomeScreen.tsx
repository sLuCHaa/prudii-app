import { Plus } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import { Button } from "../ui/Button";
import AppLogo from "../../assets/logo.webp";

export function WelcomeScreen() {
  const { t } = useTranslation();
  const setShowAccountWizard = useAppStore((s) => s.setShowAccountWizard);

  return (
    <div className="flex-1 min-w-0 flex items-center justify-center bg-bg p-8">
      <motion.div
        className="flex flex-col items-center text-center max-w-md"
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: "easeOut" }}
      >
        <img src={AppLogo} alt="Prudii Mail" className="w-20 h-20 mb-6 drop-shadow" />
        <h1 className="text-2xl font-bold text-text font-heading mb-2">
          {t("welcome.title")}
        </h1>
        <p className="text-sm text-text-secondary mb-8">
          {t("welcome.tagline")}
        </p>
        <Button
          variant="primary"
          size="lg"
          icon={<Plus />}
          onClick={() => setShowAccountWizard(true)}
        >
          {t("welcome.addAccount")}
        </Button>
        <p className="text-xs text-text-tertiary mt-6">
          {t("welcome.privacy")}
        </p>
      </motion.div>
    </div>
  );
}
