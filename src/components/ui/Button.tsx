import { useRef, useEffect, cloneElement, isValidElement } from "react";
import { Loader2 } from "lucide-react";
import gsap from "gsap";

export type ButtonVariant = "primary" | "danger" | "secondary" | "ghost" | "success";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right";
  fullWidth?: boolean;
  animated?: boolean;
}

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-white hover:bg-accent-hover border-transparent",
  danger: "bg-danger text-white hover:bg-danger/90 border-transparent",
  secondary: "bg-transparent text-text border-border hover:bg-hover hover:border-border-light",
  ghost: "bg-transparent text-text-secondary border-transparent hover:bg-hover hover:text-text",
  success: "bg-success text-white hover:bg-success/90 border-transparent",
};

const SIZE_STYLES: Record<ButtonSize, { padding: string; text: string; gap: string }> = {
  sm: { padding: "px-3 py-1.5", text: "text-sm", gap: "gap-1.5" },
  md: { padding: "px-4 py-2", text: "text-sm", gap: "gap-2" },
  lg: { padding: "px-5 py-2.5", text: "text-base", gap: "gap-2.5" },
};

const ICON_SIZES: Record<ButtonSize, number> = {
  sm: 14,
  md: 16,
  lg: 20,
};

// Helper to clone icon with proper size using inline styles (Tailwind can't process dynamic classes)
function sizeIcon(icon: React.ReactNode, size: number): React.ReactNode {
  if (isValidElement(icon)) {
    return cloneElement(icon as React.ReactElement<{ style?: React.CSSProperties; size?: number; width?: number; height?: number }>, {
      style: { width: size, height: size },
      size: size,
      width: size,
      height: size,
    });
  }
  return icon;
}

export function Button({
  variant = "primary",
  size = "md",
  loading = false,
  icon,
  iconPosition = "left",
  fullWidth = false,
  animated = true,
  disabled,
  className = "",
  children,
  onMouseEnter,
  onMouseLeave,
  onClick,
  ...props
}: ButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const glowRef = useRef<HTMLDivElement>(null);

  const sizeStyles = SIZE_STYLES[size];
  const iconSize = ICON_SIZES[size];

  // Set initial glow state (no continuous animation to save CPU/GPU)
  useEffect(() => {
    if (!animated || !glowRef.current) return;
    if (variant === "secondary" || variant === "ghost") return;
    gsap.set(glowRef.current, { opacity: 0.3, scale: 1 });
  }, [animated, variant]);

  function handleMouseEnter(e: React.MouseEvent<HTMLButtonElement>) {
    if (animated && buttonRef.current && !disabled && !loading) {
      gsap.to(buttonRef.current, {
        scale: 1.02,
        duration: 0.2,
        ease: "power2.out",
      });

      if (glowRef.current && variant !== "secondary" && variant !== "ghost") {
        gsap.to(glowRef.current, {
          opacity: 0.7,
          scale: 1.15,
          duration: 0.2,
        });
      }
    }
    onMouseEnter?.(e);
  }

  function handleMouseLeave(e: React.MouseEvent<HTMLButtonElement>) {
    if (animated && buttonRef.current) {
      gsap.to(buttonRef.current, {
        scale: 1,
        duration: 0.2,
        ease: "power2.out",
      });

      if (glowRef.current && variant !== "secondary" && variant !== "ghost") {
        gsap.to(glowRef.current, {
          opacity: 0.3,
          scale: 1,
          duration: 0.3,
        });
      }
    }
    onMouseLeave?.(e);
  }

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (animated && buttonRef.current && !disabled && !loading) {
      gsap.timeline()
        .to(buttonRef.current, {
          scale: 0.96,
          duration: 0.1,
          ease: "power2.in",
        })
        .to(buttonRef.current, {
          scale: 1,
          duration: 0.3,
          ease: "elastic.out(1, 0.5)",
        });

      const rect = buttonRef.current.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      const ripple = document.createElement("div");
      ripple.style.position = "absolute";
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      ripple.style.width = "10px";
      ripple.style.height = "10px";
      ripple.style.borderRadius = "50%";
      ripple.style.backgroundColor = "rgba(255, 255, 255, 0.4)";
      ripple.style.transform = "translate(-50%, -50%)";
      ripple.style.pointerEvents = "none";

      buttonRef.current.appendChild(ripple);

      gsap.to(ripple, {
        scale: Math.max(rect.width, rect.height) / 5,
        opacity: 0,
        duration: 0.5,
        ease: "power2.out",
        onComplete: () => ripple.remove(),
      });
    }
    onClick?.(e);
  }

  const isDisabled = disabled || loading;
  const sizedIcon = icon ? sizeIcon(icon, iconSize) : null;

  return (
    <button
      ref={buttonRef}
      disabled={isDisabled}
      className={`
        relative inline-flex items-center justify-center font-medium rounded-xl border
        transition-colors overflow-hidden
        ${VARIANT_STYLES[variant]}
        ${sizeStyles.padding}
        ${sizeStyles.text}
        ${sizeStyles.gap}
        ${fullWidth ? "w-full" : ""}
        ${isDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
        ${className}
      `}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      {...props}
    >
      {animated && variant !== "secondary" && variant !== "ghost" && (
        <div
          ref={glowRef}
          className={`absolute inset-0 blur-xl opacity-40 -z-10 ${
            variant === "primary" ? "bg-accent" :
            variant === "danger" ? "bg-danger" :
            variant === "success" ? "bg-success" : ""
          }`}
        />
      )}

      {loading ? (
        <>
          <Loader2 className="animate-spin" style={{ width: iconSize, height: iconSize }} />
          {children && <span>{children}</span>}
        </>
      ) : (
        <>
          {sizedIcon && iconPosition === "left" && sizedIcon}
          {children && <span>{children}</span>}
          {sizedIcon && iconPosition === "right" && sizedIcon}
        </>
      )}
    </button>
  );
}

interface IconButtonProps extends Omit<ButtonProps, "icon" | "iconPosition" | "children"> {
  icon: React.ReactNode;
  "aria-label": string;
}

export function IconButton({
  variant = "ghost",
  size = "md",
  className = "",
  icon,
  disabled,
  loading,
  onClick,
  ...props
}: IconButtonProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const iconSize = ICON_SIZES[size];

  const SIZE_MAP: Record<ButtonSize, string> = {
    sm: "p-1.5",
    md: "p-2",
    lg: "p-2.5",
  };

  function handleMouseEnter() {
    if (buttonRef.current && !disabled && !loading) {
      gsap.to(buttonRef.current, {
        scale: 1.1,
        duration: 0.2,
        ease: "power2.out",
      });
    }
  }

  function handleMouseLeave() {
    if (buttonRef.current) {
      gsap.to(buttonRef.current, {
        scale: 1,
        duration: 0.2,
        ease: "power2.out",
      });
    }
  }

  function handleClick(e: React.MouseEvent<HTMLButtonElement>) {
    if (buttonRef.current && !disabled && !loading) {
      gsap.timeline()
        .to(buttonRef.current, {
          scale: 0.85,
          duration: 0.1,
          ease: "power2.in",
        })
        .to(buttonRef.current, {
          scale: 1,
          duration: 0.25,
          ease: "back.out(2)",
        });
    }
    onClick?.(e);
  }

  const sizedIcon = sizeIcon(icon, iconSize);

  return (
    <button
      ref={buttonRef}
      disabled={disabled || loading}
      className={`
        inline-flex items-center justify-center rounded-lg transition-colors
        ${variant === "ghost" ? "text-text-tertiary hover:text-text hover:bg-hover" : VARIANT_STYLES[variant]}
        ${SIZE_MAP[size]}
        ${disabled || loading ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
        ${className}
      `}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      {...props}
    >
      {loading ? (
        <Loader2 className="animate-spin" style={{ width: iconSize, height: iconSize }} />
      ) : (
        sizedIcon
      )}
    </button>
  );
}
