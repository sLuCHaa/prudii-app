import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import { useTranslation } from "react-i18next";
import AppLogo from "../../assets/logo.webp";

interface SplashScreenProps {
  onComplete: () => void;
  duration?: number;
}

export function SplashScreen({ onComplete, duration = 2000 }: SplashScreenProps) {
  const { t } = useTranslation();
  const [phase, setPhase] = useState<"enter" | "hold" | "exit">("enter");

  useEffect(() => {
    // Enter animation complete → hold
    const holdTimer = setTimeout(() => setPhase("hold"), 600);
    // Hold complete → exit
    const exitTimer = setTimeout(() => setPhase("exit"), duration - 400);
    // Exit complete → done
    const doneTimer = setTimeout(onComplete, duration);

    return () => {
      clearTimeout(holdTimer);
      clearTimeout(exitTimer);
      clearTimeout(doneTimer);
    };
  }, [onComplete, duration]);

  return (
    <AnimatePresence>
      {phase !== "exit" ? null : (
        <motion.div
          key="splash-exit"
          initial={{ opacity: 1 }}
          animate={{ opacity: 0 }}
          transition={{ duration: 0.4, ease: "easeInOut" }}
          className="fixed inset-0 z-50"
        />
      )}
      <motion.div
        key="splash"
        initial={{ opacity: 0 }}
        animate={{ opacity: phase === "exit" ? 0 : 1 }}
        transition={{ duration: 0.3 }}
        className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-linear-to-br from-slate-900 via-purple-900 to-slate-900"
      >
        {/* Animated glow behind logo */}
        <motion.div
          initial={{ scale: 0.5, opacity: 0 }}
          animate={{
            scale: [0.5, 1.2, 1],
            opacity: [0, 0.6, 0.3]
          }}
          transition={{ duration: 1, ease: "easeOut" }}
          className="absolute w-64 h-64 rounded-full bg-linear-to-r from-orange-400 via-pink-500 to-purple-600 blur-3xl"
        />

        <motion.div
          initial={{ scale: 0, rotate: -180, opacity: 0 }}
          animate={{
            scale: [0, 1.1, 1],
            rotate: [-180, 10, 0],
            opacity: 1
          }}
          transition={{
            duration: 0.8,
            ease: [0.34, 1.56, 0.64, 1], // Spring-like bounce
            times: [0, 0.7, 1]
          }}
          className="relative z-10"
        >
          {/* Rotating ring */}
          <motion.div
            initial={{ opacity: 0, scale: 0.8 }}
            animate={{
              opacity: [0, 1, 0],
              scale: [0.8, 1.3, 1.5],
              rotate: 360
            }}
            transition={{
              duration: 1.2,
              delay: 0.3,
              ease: "easeOut"
            }}
            className="absolute inset-0 -m-4 rounded-full border-2 border-white/20"
          />

          <motion.img
            src={AppLogo}
            alt="Prudii Mail"
            className="w-32 h-32 drop-shadow-2xl"
            initial={{ filter: "brightness(0)" }}
            animate={{ filter: "brightness(1)" }}
            transition={{ duration: 0.5, delay: 0.3 }}
          />
        </motion.div>

        <motion.h1
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.5 }}
          className="mt-6 text-3xl font-bold text-white tracking-tight font-heading"
        >
          Prudii Mail
        </motion.h1>

        <motion.p
          initial={{ opacity: 0, y: 10 }}
          animate={{ opacity: 0.7, y: 0 }}
          transition={{ duration: 0.5, delay: 0.7 }}
          className="mt-2 text-sm text-white/60 font-body"
        >
          {t("splash.tagline")}
        </motion.p>

        {/* Loading indicator */}
        <motion.div
          initial={{ opacity: 0, scaleX: 0 }}
          animate={{ opacity: 1, scaleX: 1 }}
          transition={{ duration: 0.8, delay: 0.9 }}
          className="mt-8 w-32 h-0.5 bg-white/10 rounded-full overflow-hidden origin-left"
        >
          <motion.div
            initial={{ x: "-100%" }}
            animate={{ x: "100%" }}
            transition={{
              duration: 0.8,
              delay: 1,
              ease: "easeInOut"
            }}
            className="h-full w-full bg-linear-to-r from-orange-400 via-pink-500 to-purple-500"
          />
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
