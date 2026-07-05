// Glue between the app store's toasts and the StackedToast primitive.
// Public API (ToastType, ToastData) is preserved so existing callers
// (appStore.addToast, App.tsx event handlers) keep working.

import { useEffect } from "react";
import { Check, X, AlertCircle, Info } from "lucide-react";
import { useAppStore } from "../../stores/appStore";
import { StackedToast, type StackedToastItem } from "../motion/StackedToast";

export type ToastType = "success" | "error" | "warning" | "info";

export interface ToastData {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
}

const ICONS = {
  success: Check,
  error: X,
  warning: AlertCircle,
  info: Info,
};

const ICON_BG = {
  success: "bg-success/20 text-success",
  error: "bg-danger/20 text-danger",
  warning: "bg-warning/20 text-warning",
  info: "bg-accent/20 text-accent",
};

function useAutoDismiss(id: string, duration: number | undefined, type: ToastType) {
  const removeToast = useAppStore((s) => s.removeToast);
  useEffect(() => {
    // Errors stay until user dismisses.
    if (type === "error") return;
    const ms = duration ?? 4000;
    const t = setTimeout(() => removeToast(id), ms);
    return () => clearTimeout(t);
  }, [id, duration, type, removeToast]);
}

function ToastBody({ toast }: { toast: ToastData }) {
  const Icon = ICONS[toast.type];
  const iconCls = ICON_BG[toast.type];
  const removeToast = useAppStore((s) => s.removeToast);
  useAutoDismiss(toast.id, toast.duration, toast.type);

  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <div className={`w-6 h-6 rounded-full ${iconCls} flex items-center justify-center shrink-0 mt-0.5`}>
        <Icon className="w-4 h-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text">{toast.title}</p>
        {toast.message && (
          <p className="text-xs text-text-secondary mt-0.5 line-clamp-2">{toast.message}</p>
        )}
      </div>
      <button
        onClick={() => removeToast(toast.id)}
        className="p-0.5 rounded hover:bg-hover transition-colors text-text-tertiary shrink-0"
        aria-label="Dismiss"
      >
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export function ToastContainer() {
  const toasts = useAppStore((s) => s.toasts);
  const removeToast = useAppStore((s) => s.removeToast);

  const items: StackedToastItem[] = toasts.map((t) => ({
    id: t.id,
    variant: t.type,
    dismissible: true,
    onDismiss: () => removeToast(t.id),
    render: () => <ToastBody toast={t} />,
  }));

  return <StackedToast toasts={items} position="bottom-right" maxVisible={3} />;
}
