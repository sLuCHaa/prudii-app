// Initials avatar with a gradient deterministically derived from email.
// Optionally wears a glowing ring (used in wizard done step + selected mail
// rows). Reuses gradientFromEmail/initialsFromName helpers — single source
// of truth for sender→color mapping.

import { useMemo } from "react";
import { gradientFromEmail, initialsFromName } from "../../lib/gradientFromEmail";

interface GradientAvatarProps {
  email: string;
  name?: string;
  size?: number;
  /** Wear an accent-coloured glowing ring (for hero contexts). */
  ring?: boolean;
  className?: string;
}

export function GradientAvatar({
  email,
  name = "",
  size = 32,
  ring = false,
  className = "",
}: GradientAvatarProps) {
  const { initials, gradient } = useMemo(
    () => ({
      initials: initialsFromName(name, email),
      gradient: gradientFromEmail(email),
    }),
    [name, email],
  );

  const fontSize = Math.max(10, Math.round(size * 0.4));

  return (
    <div
      className={`shrink-0 rounded-full flex items-center justify-center font-medium text-white select-none ${className}`}
      style={{
        width: size,
        height: size,
        background: gradient,
        fontSize,
        lineHeight: 1,
        boxShadow: ring
          ? "0 0 0 3px var(--c-bg), 0 0 0 5px var(--c-accent), 0 8px 24px rgba(59,130,246,.35)"
          : undefined,
      }}
      aria-label={name || email}
    >
      {initials}
    </div>
  );
}
