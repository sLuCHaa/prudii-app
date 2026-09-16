import { cloneElement, isValidElement } from "react";
import { Loader2 } from "lucide-react";

export type ButtonVariant = "primary" | "danger" | "secondary" | "ghost" | "success" | "signal";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  icon?: React.ReactNode;
  iconPosition?: "left" | "right";
  fullWidth?: boolean;
  /** Press feedback (fill step plus 1px sink). Off for controls that must not move, e.g. inside a drag handle. */
  animated?: boolean;
}

// Filled variants carry a real drop shadow that collapses on press — native
// controls signal depth, not a Material ripple and not a scale transform.
const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent border-transparent hover:bg-accent-hover shadow-[0_1px_2px_rgba(0,0,0,0.18)]",
  danger: "bg-danger text-white border-transparent hover:bg-danger/90 shadow-[0_1px_2px_rgba(0,0,0,0.18)]",
  success: "bg-success text-white border-transparent hover:bg-success/90 shadow-[0_1px_2px_rgba(0,0,0,0.18)]",
  signal: "bg-signal text-bg border-transparent hover:brightness-95 shadow-[0_1px_2px_rgba(0,0,0,0.18)]",
  secondary: "bg-surface text-text border-border hover:bg-hover hover:border-border-light",
  ghost: "bg-transparent text-text-secondary border-transparent hover:bg-hover hover:text-text",
};

const SIZE_STYLES: Record<ButtonSize, { padding: string; text: string; gap: string }> = {
  sm: { padding: "px-4 py-1.5", text: "text-sm", gap: "gap-1.5" },
  md: { padding: "px-5 py-2", text: "text-sm", gap: "gap-2" },
  lg: { padding: "px-6 py-2.5", text: "text-base", gap: "gap-2.5" },
};

const ICON_SIZES: Record<ButtonSize, number> = {
  sm: 14,
  md: 16,
  lg: 20,
};

// Press feedback. A macOS push button answers a press by darkening its fill
// immediately and easing back on release — that colour step IS the signal, and
// the 1px sink only supports it. Without it a press reads as nothing at all,
// because the pointer already sits in the hover state when the click lands.
// duration-0 on :active keeps the press instant while the release still eases.
// Still no scale: native controls never grow or shrink.
const PRESS_FILLED =
  "active:brightness-90 active:translate-y-px active:duration-0 " +
  "active:shadow-[inset_0_1px_3px_rgba(0,0,0,0.28)] motion-reduce:active:translate-y-0";

// A brightness filter barely shows on the near-black surfaces of the dark
// theme, so the quiet variants step to --c-active instead, which is defined
// per theme. Tailwind's `dark:` cannot help here: no @custom-variant is
// registered, so it would follow the OS setting rather than the .dark class.
const PRESS_QUIET =
  "active:bg-active active:translate-y-px active:duration-0 motion-reduce:active:translate-y-0";

const PRESS: Record<ButtonVariant, string> = {
  primary: PRESS_FILLED,
  danger: PRESS_FILLED,
  success: PRESS_FILLED,
  signal: PRESS_FILLED,
  secondary: PRESS_QUIET,
  ghost: PRESS_QUIET,
};

const TRANSITION = "transition-[color,background-color,border-color,box-shadow,transform,filter] duration-150 ease-out";

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
  ...props
}: ButtonProps) {
  const sizeStyles = SIZE_STYLES[size];
  const iconSize = ICON_SIZES[size];
  const isDisabled = disabled || loading;
  const sizedIcon = icon ? sizeIcon(icon, iconSize) : null;

  return (
    <button
      disabled={isDisabled}
      className={`
        relative inline-flex items-center justify-center font-medium rounded-full border
        ${TRANSITION}
        ${VARIANT_STYLES[variant]}
        ${sizeStyles.padding}
        ${sizeStyles.text}
        ${sizeStyles.gap}
        ${fullWidth ? "w-full" : ""}
        ${animated && !isDisabled ? PRESS[variant] : ""}
        ${isDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
        ${className}
      `}
      {...props}
    >
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
  animated = true,
  ...props
}: IconButtonProps) {
  const iconSize = ICON_SIZES[size];
  const isDisabled = disabled || loading;

  const SIZE_MAP: Record<ButtonSize, string> = {
    sm: "p-1.5",
    md: "p-2",
    lg: "p-2.5",
  };

  const sizedIcon = sizeIcon(icon, iconSize);

  return (
    <button
      disabled={isDisabled}
      className={`
        inline-flex items-center justify-center rounded-full border border-transparent
        ${TRANSITION}
        ${variant === "ghost" ? "text-text-tertiary hover:text-text hover:bg-hover" : VARIANT_STYLES[variant]}
        ${SIZE_MAP[size]}
        ${animated && !isDisabled ? PRESS[variant] : ""}
        ${isDisabled ? "opacity-50 cursor-not-allowed" : "cursor-pointer"}
        ${className}
      `}
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
