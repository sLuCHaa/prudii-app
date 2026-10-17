import type { ReactNode } from "react";

const cn = (...parts: (string | undefined)[]) => parts.filter(Boolean).join(" ");

export function SettingsGroup({ title, icon, action, children, className }: {
  title: ReactNode;
  icon?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("settings-group", className)}>
      <div className="settings-group-label">
        {icon}
        <h3>{title}</h3>
        {action}
      </div>
      <div className="settings-group-card">{children}</div>
    </section>
  );
}

export function SettingsBlock({ description, children, className }: {
  description?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("settings-block", className)}>
      {description && <p className="settings-block-desc">{description}</p>}
      {children}
    </div>
  );
}

export function SettingsRow({ title, description, icon, control, as, onClick, className, children }: {
  title: ReactNode;
  description?: ReactNode;
  icon?: ReactNode;
  control?: ReactNode;
  as?: "label" | "div";
  onClick?: () => void;
  className?: string;
  children?: ReactNode;
}) {
  const body = (
    <>
      {icon}
      <div className="settings-row-text">
        <div className="settings-row-title">{title}</div>
        {description && <div className="settings-row-desc">{description}</div>}
        {children}
      </div>
      {control}
    </>
  );
  if (control && as !== "div") return <label className={cn("settings-row", className)}>{body}</label>;
  return (
    <div
      className={cn("settings-row", className)}
      data-clickable={onClick ? "" : undefined}
      onClick={onClick}
      role={onClick ? "button" : undefined}
      tabIndex={onClick ? 0 : undefined}
      onKeyDown={onClick ? (e) => {
        if (e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
        e.preventDefault();
        onClick();
      } : undefined}
    >
      {body}
    </div>
  );
}
