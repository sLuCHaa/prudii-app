import { motion } from "motion/react";

interface SkeletonProps {
  width?: string;
  height?: string;
  rounded?: "sm" | "md" | "lg" | "full";
  className?: string;
}

const ROUNDED = {
  sm: "rounded",
  md: "rounded-md",
  lg: "rounded-lg",
  full: "rounded-full",
};

export function Skeleton({ width = "100%", height = "1rem", rounded = "md", className = "" }: SkeletonProps) {
  return (
    <motion.div
      className={`bg-border/50 overflow-hidden ${ROUNDED[rounded]} ${className}`}
      style={{ width, height }}
      initial={{ opacity: 0.6 }}
      animate={{ opacity: [0.6, 1, 0.6] }}
      transition={{
        duration: 1.5,
        repeat: Infinity,
        ease: "easeInOut",
      }}
    >
      <motion.div
        className="h-full w-full bg-linear-to-r from-transparent via-white/10 to-transparent"
        initial={{ x: "-100%" }}
        animate={{ x: "100%" }}
        transition={{
          duration: 1.5,
          repeat: Infinity,
          ease: "easeInOut",
        }}
      />
    </motion.div>
  );
}

export function SkeletonText({ lines = 1, className = "" }: { lines?: number; className?: string }) {
  return (
    <div className={`space-y-2 ${className}`}>
      {Array.from({ length: lines }).map((_, i) => (
        <Skeleton
          key={i}
          height="0.875rem"
          width={i === lines - 1 ? "80%" : "100%"}
          rounded="sm"
        />
      ))}
    </div>
  );
}

export function SkeletonCircle({ size = "2rem", className = "" }: { size?: string; className?: string }) {
  return <Skeleton width={size} height={size} rounded="full" className={className} />;
}
