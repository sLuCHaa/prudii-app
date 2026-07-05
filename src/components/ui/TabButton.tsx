import { forwardRef } from "react";

export function TabButton({
  selected,
  onClick,
  children,
  orientation = "horizontal",
  className = "",
  ...rest
}: {
  selected: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  orientation?: "horizontal" | "vertical";
  className?: string;
} & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children">) {
  const base = "text-sm font-medium px-3 py-2 transition-colors";
  const borderSide = orientation === "vertical" ? "border-l-2" : "border-b-2";
  const colors = selected
    ? `bg-accent/10 text-text ${borderSide} border-accent`
    : `text-text-secondary hover:bg-hover hover:text-text ${borderSide} border-transparent`;
  return (
    <button type="button" onClick={onClick} className={`${base} ${colors} ${className}`} {...rest}>
      {children}
    </button>
  );
}

export const CardButton = forwardRef<
  HTMLButtonElement,
  {
    selected?: boolean;
    onClick?: () => void;
    leading?: React.ReactNode;
    trailing?: React.ReactNode;
    children: React.ReactNode;
    className?: string;
  } & Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onClick" | "children">
>(function CardButton(
  { selected, onClick, leading, trailing, children, className = "", ...rest },
  ref
) {
  return (
    <button
      ref={ref}
      type="button"
      onClick={onClick}
      style={{ borderLeft: `3px solid ${selected ? "var(--c-accent)" : "transparent"}` }}
      className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
        selected ? "bg-accent/10 text-accent" : "hover:bg-hover text-text"
      } ${className}`}
      {...rest}
    >
      {leading && <span className="shrink-0">{leading}</span>}
      <span className="flex-1 min-w-0 truncate">{children}</span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </button>
  );
});
