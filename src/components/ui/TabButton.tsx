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
  const layout = orientation === "vertical" ? "w-full justify-start" : "flex-none";
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onClick}
      className={`segmented-item ${layout} text-sm ${className}`}
      {...rest}
    >
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
      className={`w-full text-left px-3 py-2 flex items-center gap-2 transition-colors ${
        selected ? "tile-raised font-semibold text-text" : "hover:bg-hover text-text"
      } ${className}`}
      {...rest}
    >
      {leading && <span className={`shrink-0 ${selected ? "text-accent" : ""}`}>{leading}</span>}
      <span className="flex-1 min-w-0 truncate">{children}</span>
      {trailing && <span className="shrink-0">{trailing}</span>}
    </button>
  );
});
