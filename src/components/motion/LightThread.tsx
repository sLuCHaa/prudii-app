export type LightThreadForm = "area" | "edge" | "mini";
export type LightThreadTone = "accent" | "current" | "warning";

interface LightThreadProps {
  form: LightThreadForm;
  tone?: LightThreadTone;
  /** Kept mounted with `on={false}` where the thread should fade out instead of vanishing. */
  on?: boolean;
  width?: number;
  inset?: number;
  label?: string;
  className?: string;
}

/** The sync line's shimmer as the app-wide loading indicator. */
export function LightThread({ form, tone = "accent", on = true, width, inset, label, className = "" }: LightThreadProps) {
  const style: Record<string, string> = {};
  if (width !== undefined) style["--thread-w"] = `${width}px`;
  if (inset !== undefined) style["--thread-inset"] = `${inset}px`;
  return (
    <span
      className={`light-thread ${className}`}
      data-form={form}
      data-tone={tone}
      data-on={on}
      style={style as React.CSSProperties}
      role={label ? "status" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <i />
    </span>
  );
}
