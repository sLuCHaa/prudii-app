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
  /** Lift and press feedback. Off for controls that must not move, e.g. inside a drag handle. */
  animated?: boolean;
}

const FILLED = "tactile-filled";

const VARIANT_STYLES: Record<ButtonVariant, string> = {
  primary: `${FILLED} [--tactile-fill:var(--c-accent)] text-on-accent`,
  danger: `${FILLED} [--tactile-fill:var(--c-danger)] text-white`,
  success: `${FILLED} [--tactile-fill:var(--c-success)] text-white`,
  signal: `${FILLED} [--tactile-fill:var(--c-signal)] text-bg`,
  secondary: "tactile-quiet text-text",
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

// Only ghost presses by itself; the other variants get hover and press from the tactile classes.
const PRESS_GHOST =
  "active:bg-active active:translate-y-px active:duration-0 " +
  "active:shadow-[inset_0_2px_4px_rgba(0,0,0,0.20)] motion-reduce:active:translate-y-0";

function pressStyle(variant: ButtonVariant, animated: boolean, isDisabled: boolean): string {
  if (variant === "ghost") return animated && !isDisabled ? PRESS_GHOST : "";
  return animated && !isDisabled ? "" : "tactile-static";
}

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
        relative inline-flex items-center justify-center font-medium rounded-control border
        ${TRANSITION}
        ${VARIANT_STYLES[variant]}
        ${sizeStyles.padding}
        ${sizeStyles.text}
        ${sizeStyles.gap}
        ${fullWidth ? "w-full" : ""}
        ${pressStyle(variant, animated, Boolean(isDisabled))}
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
        inline-flex items-center justify-center rounded-control border
        ${TRANSITION}
        ${variant === "ghost" ? "border-transparent text-text-tertiary hover:text-text hover:bg-hover" : VARIANT_STYLES[variant]}
        ${SIZE_MAP[size]}
        ${pressStyle(variant, animated, Boolean(isDisabled))}
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
