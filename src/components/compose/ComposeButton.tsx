import { useRef } from "react";
import { Compose as Pencil } from "../icons";

import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import gsap from "gsap";
import { prefersReducedMotion } from "../motion/tokens";

const ACTIVE = "tactile-filled text-on-accent border transition-[color,background-color,border-color,box-shadow,transform,filter] duration-150 ease-out active:duration-0";
const INACTIVE = "bg-border/50 text-text-tertiary opacity-50 cursor-default";
// Particles fly beyond the button onto the sidebar, so they take the accent rather than white.
const PARTICLE_COLORS = ["var(--c-accent)", "color-mix(in srgb, var(--c-accent) 60%, white)", "color-mix(in srgb, var(--c-accent) 75%, black)"];

export function ComposeButton({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const openCompose = useAppStore((s) => s.openCompose);
  const accounts = useAppStore((s) => s.accounts);
  const hasAccounts = accounts.length > 0;
  const iconRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const particlesRef = useRef<HTMLDivElement>(null);

  function handleMouseEnter() {
    if (prefersReducedMotion()) return;
    if (!iconRef.current || !textRef.current) return;

    gsap.to(iconRef.current, {
      rotation: 15,
      scale: 1.2,
      duration: 0.3,
      ease: "back.out(2)",
    });

    gsap.to(textRef.current, {
      x: 4,
      duration: 0.3,
      ease: "power2.out",
    });
  }

  function handleMouseLeave() {
    if (prefersReducedMotion()) return;
    if (!iconRef.current || !textRef.current) return;

    gsap.to(iconRef.current, {
      rotation: 0,
      scale: 1,
      duration: 0.3,
      ease: "power2.out",
    });

    gsap.to(textRef.current, {
      x: 0,
      duration: 0.3,
      ease: "power2.out",
    });
  }

  function handleClick() {
    if (!hasAccounts) return;
    // Animation is skippable; opening the compose window never is.
    if (prefersReducedMotion() || !particlesRef.current) {
      openCompose("new");
      return;
    }

    const particles = particlesRef.current;

    for (let i = 0; i < 8; i++) {
      const particle = document.createElement("div");
      particle.className = "absolute w-1.5 h-1.5 rounded-full";
      particle.style.backgroundColor = PARTICLE_COLORS[i % PARTICLE_COLORS.length];
      particle.style.left = "50%";
      particle.style.top = "50%";
      particles.appendChild(particle);

      const angle = (i / 8) * Math.PI * 2;
      const distance = 30 + Math.random() * 20;

      gsap.fromTo(
        particle,
        { x: 0, y: 0, scale: 1, opacity: 1 },
        {
          x: Math.cos(angle) * distance,
          y: Math.sin(angle) * distance,
          scale: 0,
          opacity: 0,
          duration: 0.5,
          ease: "power2.out",
          onComplete: () => particle.remove(),
        }
      );
    }

    openCompose("new");
  }

  if (collapsed) {
    return (
      <button
        disabled={!hasAccounts}
        className={`relative flex items-center justify-center w-9 h-9 rounded-control mx-auto ${hasAccounts ? ACTIVE : INACTIVE}`}
        onClick={handleClick}
        title={t("compose.compose")}
      >
        {hasAccounts && (
          <div ref={particlesRef} className="absolute inset-0 pointer-events-none overflow-visible" />
        )}
        <Pencil className="w-4 h-4" />
      </button>
    );
  }

  return (
    <button
      disabled={!hasAccounts}
      className={`relative flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-control font-medium text-sm ${hasAccounts ? ACTIVE : INACTIVE}`}
      onClick={handleClick}
      onMouseEnter={hasAccounts ? handleMouseEnter : undefined}
      onMouseLeave={hasAccounts ? handleMouseLeave : undefined}
    >
      {hasAccounts && (
        <div ref={particlesRef} className="absolute inset-0 pointer-events-none overflow-visible" />
      )}

      <div ref={iconRef} className="relative">
        <Pencil className="w-4 h-4" />
      </div>

      <span ref={textRef} className="relative">
        {t("compose.compose")}
      </span>
    </button>
  );
}
