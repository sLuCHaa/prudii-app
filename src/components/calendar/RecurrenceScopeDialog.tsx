import { useCallback, useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Repeat } from "lucide-react";
import type { EditScope } from "../../types/calendar";
import { useFocusTrap } from "../../hooks/useFocusTrap";

interface RecurrenceScopeDialogProps {
  kind: "edit" | "delete";
  allowThis: boolean;
  onChoose: (scope: EditScope | null) => void;
}

export function RecurrenceScopeDialog({ kind, allowThis, onChoose }: RecurrenceScopeDialogProps) {
  const { t } = useTranslation();
  const ref = useFocusTrap<HTMLDivElement>(true);

  useEffect(() => {
    // Capture phase: the drawer behind must not also close on this Escape.
    function onKey(e: KeyboardEvent) {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onChoose(null);
    }
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [onChoose]);

  const scopes: EditScope[] = allowThis ? ["this", "following", "all"] : ["following", "all"];
  return (
    <div
      className="fixed inset-0 z-[60] modal-backdrop grid place-items-center"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onChoose(null);
      }}
    >
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="calendar-scope-title" className="w-[340px] rounded-xl border border-border bg-surface p-5 shadow-2xl inset-shadow-edge">
        <div className="flex items-center gap-2 mb-4">
          <Repeat className="w-4 h-4 text-accent" />
          <h2 id="calendar-scope-title" className="text-sm font-semibold text-text">
            {t(kind === "edit" ? "calendar.scope.editTitle" : "calendar.scope.deleteTitle")}
          </h2>
        </div>
        <div className="grid gap-2">
          {scopes.map((scope) => (
            <button
              key={scope}
              type="button"
              onClick={() => onChoose(scope)}
              className={`w-full text-left px-3 py-2 rounded-lg border border-border text-sm hover:bg-hover transition-colors ${
                kind === "delete" && scope === "all" ? "text-danger" : "text-text"
              }`}
            >
              {t(`calendar.scope.${scope}`)}
            </button>
          ))}
        </div>
        <div className="mt-4 flex justify-end">
          <button type="button" onClick={() => onChoose(null)} className="px-3 py-1.5 rounded-lg text-xs text-text-secondary hover:bg-hover">
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Promise-style prompt; render `element` once in the owning component. */
export function useScopePrompt(): {
  prompt: (kind: "edit" | "delete", allowThis?: boolean) => Promise<EditScope | null>;
  element: ReactNode;
} {
  const [state, setState] = useState<{ kind: "edit" | "delete"; allowThis: boolean; resolve: (s: EditScope | null) => void } | null>(null);
  const prompt = useCallback(
    (kind: "edit" | "delete", allowThis = true) => new Promise<EditScope | null>((resolve) => setState({ kind, allowThis, resolve })),
    [],
  );
  const element = state ? (
    <RecurrenceScopeDialog
      kind={state.kind}
      allowThis={state.allowThis}
      onChoose={(scope) => {
        state.resolve(scope);
        setState(null);
      }}
    />
  ) : null;
  return { prompt, element };
}
