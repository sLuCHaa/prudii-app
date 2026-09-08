import type { ReactNode } from "react";

/** Shared header row for the drawer's body sections: optional leading indicator,
 *  heading, count, and a right-aligned action. */
export function TaskSectionHead({
  title,
  count,
  children,
  action,
}: {
  title: string;
  count?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-center gap-2 mb-2">
      {children}
      <h4 className="font-heading text-[13.5px] font-bold text-text">{title}</h4>
      {count !== undefined && <span className="text-xs text-text-tertiary tabular-nums">{count}</span>}
      {action && (
        <>
          <span className="flex-1" />
          {action}
        </>
      )}
    </div>
  );
}

export const SECTION_ACTION =
  "inline-flex items-center gap-1.5 px-2 py-1 rounded-lg text-xs font-medium text-accent hover:bg-accent/10 transition-colors disabled:opacity-50";
