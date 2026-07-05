import { useRef, useEffect } from "react";
import { Pencil, Send } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useAppStore } from "../../stores/appStore";
import gsap from "gsap";

export function ComposeButton({ collapsed = false }: { collapsed?: boolean }) {
  const { t } = useTranslation();
  const openCompose = useAppStore((s) => s.openCompose);
  const accounts = useAppStore((s) => s.accounts);
  const hasAccounts = accounts.length > 0;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLSpanElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);
  const particlesRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!glowRef.current) return;
    // Static glow — no continuous animation to save CPU/GPU
    gsap.set(glowRef.current, { opacity: hasAccounts ? 0.4 : 0, scale: 1 });
  }, [hasAccounts]);

  function handleMouseEnter() {
    if (!buttonRef.current || !iconRef.current || !textRef.current) return;

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

    gsap.to(glowRef.current, {
      opacity: 1,
      scale: 1.3,
      duration: 0.3,
    });
  }

  function handleMouseLeave() {
    if (!iconRef.current || !textRef.current || !glowRef.current) return;

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

    gsap.to(glowRef.current, {
      opacity: 0.4,
      scale: 1,
      duration: 0.3,
    });
  }

  function handleClick() {
    if (!hasAccounts) return;
    if (!buttonRef.current || !particlesRef.current) return;

    gsap.timeline()
      .to(buttonRef.current, {
        scale: 0.95,
        duration: 0.1,
        ease: "power2.in",
      })
      .to(buttonRef.current, {
        scale: 1,
        duration: 0.3,
        ease: "elastic.out(1, 0.5)",
      });

    const particles = particlesRef.current;
    const colors = ["#fff", "#e0e7ff", "#c7d2fe"];

    for (let i = 0; i < 8; i++) {
      const particle = document.createElement("div");
      particle.className = "absolute w-1.5 h-1.5 rounded-full";
      particle.style.backgroundColor = colors[i % colors.length];
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
        ref={buttonRef}
        disabled={!hasAccounts}
        className={`relative flex items-center justify-center w-9 h-9 rounded-full mx-auto overflow-hidden transition-all duration-300 ${
          hasAccounts
            ? "bg-linear-to-r from-accent to-accent-hover text-white"
            : "bg-border/50 text-text-tertiary opacity-50 cursor-default"
        }`}
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
      ref={buttonRef}
      disabled={!hasAccounts}
      className={`relative flex items-center justify-center gap-2 w-full px-4 py-2.5 rounded-xl font-medium text-sm overflow-hidden transition-all duration-300 ${
        hasAccounts
          ? "bg-linear-to-r from-accent to-accent-hover text-white"
          : "bg-border/50 text-text-tertiary opacity-50 cursor-default"
      }`}
      onClick={handleClick}
      onMouseEnter={hasAccounts ? handleMouseEnter : undefined}
      onMouseLeave={hasAccounts ? handleMouseLeave : undefined}
    >
      {hasAccounts && (
        <div
          ref={glowRef}
          className="absolute inset-0 bg-linear-to-r from-accent/50 to-purple-500/50 blur-xl opacity-60 -z-10"
        />
      )}

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
