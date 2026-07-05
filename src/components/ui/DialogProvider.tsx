import { createContext, useContext, useState, useCallback, useRef, useEffect } from "react";
import { Info, CheckCircle, Trash2, AlertCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import gsap from "gsap";
import { Button } from "./Button";

type DialogType = "confirm" | "alert" | "danger" | "success" | "info";

interface DialogButton {
  label: string;
  variant?: "primary" | "danger" | "secondary";
  onClick?: () => void;
}

interface DialogOptions {
  type?: DialogType;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  icon?: React.ReactNode;
}

interface DialogContextType {
  confirm: (options: DialogOptions) => Promise<boolean>;
  alert: (options: Omit<DialogOptions, "cancelLabel">) => Promise<void>;
  danger: (options: DialogOptions) => Promise<boolean>;
  isOpen: boolean;
}

const DialogContext = createContext<DialogContextType | null>(null);

export function useDialog() {
  const context = useContext(DialogContext);
  if (!context) {
    throw new Error("useDialog must be used within a DialogProvider");
  }
  return context;
}

const DIALOG_ICONS: Record<DialogType, React.ReactNode> = {
  confirm: <AlertCircle className="w-6 h-6" />,
  alert: <Info className="w-6 h-6" />,
  danger: <Trash2 className="w-6 h-6" />,
  success: <CheckCircle className="w-6 h-6" />,
  info: <Info className="w-6 h-6" />,
};

const DIALOG_COLORS: Record<DialogType, { bg: string; text: string; button: string }> = {
  confirm: { bg: "bg-accent/10", text: "text-accent", button: "bg-accent hover:bg-accent-hover" },
  alert: { bg: "bg-blue-500/10", text: "text-blue-500", button: "bg-blue-500 hover:bg-blue-600" },
  danger: { bg: "bg-danger/10", text: "text-danger", button: "bg-danger hover:bg-danger/90" },
  success: { bg: "bg-success/10", text: "text-success", button: "bg-success hover:bg-success/90" },
  info: { bg: "bg-blue-500/10", text: "text-blue-500", button: "bg-blue-500 hover:bg-blue-600" },
};

interface DialogState {
  isOpen: boolean;
  options: DialogOptions | null;
  resolve: ((value: boolean) => void) | null;
}

function Dialog({ state, onClose }: { state: DialogState; onClose: (result: boolean) => void }) {
  const { t } = useTranslation();
  const overlayRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const iconRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!state.isOpen || !overlayRef.current || !dialogRef.current) return;

    gsap.fromTo(overlayRef.current,
      { opacity: 0 },
      { opacity: 1, duration: 0.2, ease: "power2.out" }
    );

    gsap.fromTo(dialogRef.current,
      { opacity: 0, scale: 0.9, y: 20 },
      { opacity: 1, scale: 1, y: 0, duration: 0.3, ease: "back.out(1.5)" }
    );

    if (iconRef.current) {
      gsap.fromTo(iconRef.current,
        { scale: 0, rotation: -180 },
        { scale: 1, rotation: 0, duration: 0.4, delay: 0.1, ease: "back.out(2)" }
      );
    }
  }, [state.isOpen]);

  const handleClose = useCallback((result: boolean) => {
    if (!overlayRef.current || !dialogRef.current) {
      onClose(result);
      return;
    }

    gsap.to(dialogRef.current, {
      opacity: 0,
      scale: 0.9,
      y: 20,
      duration: 0.2,
      ease: "power2.in",
    });

    gsap.to(overlayRef.current, {
      opacity: 0,
      duration: 0.2,
      ease: "power2.in",
      onComplete: () => onClose(result),
    });
  }, [onClose]);

  useEffect(() => {
    if (!state.isOpen) return;

    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        handleClose(false);
      } else if (e.key === "Enter") {
        handleClose(true);
      } else if (e.key === "Tab" && dialogRef.current) {
        // Focus trap: keep Tab within the dialog
        const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    }

    if (dialogRef.current) {
      const firstButton = dialogRef.current.querySelector<HTMLElement>("button");
      firstButton?.focus();
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [state.isOpen, handleClose]);

  if (!state.isOpen || !state.options) return null;

  const { type = "confirm", title, message, confirmLabel, cancelLabel, icon } = state.options;
  const colors = DIALOG_COLORS[type];
  const showCancel = type === "confirm" || type === "danger";

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 modal-backdrop flex items-center justify-center z-100"
      onClick={(e) => e.target === e.currentTarget && handleClose(false)}
    >
      <div
        ref={dialogRef}
        className="bg-surface rounded-2xl shadow-2xl w-full max-w-sm mx-4 overflow-hidden"
      >
        <div className="p-6">
          <div className="flex items-start gap-4">
            <div
              ref={iconRef}
              className={`p-3 rounded-full ${colors.bg} ${colors.text} shrink-0`}
            >
              {icon || DIALOG_ICONS[type]}
            </div>

            <div className="flex-1 min-w-0 pt-1">
              <h3 className="text-lg font-semibold text-text mb-2">{title}</h3>
              <p className="text-sm text-text-secondary leading-relaxed">{message}</p>
            </div>
          </div>
        </div>

        <div className="flex gap-3 p-4 pt-0">
          {showCancel && (
            <Button
              variant="secondary"
              fullWidth
              onClick={() => handleClose(false)}
            >
              {cancelLabel || t("dialog.cancel")}
            </Button>
          )}
          <Button
            variant={type === "danger" ? "danger" : type === "success" ? "success" : "primary"}
            fullWidth
            onClick={() => handleClose(true)}
          >
            {confirmLabel || (showCancel ? t("dialog.confirm") : t("dialog.ok"))}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function DialogProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DialogState>({
    isOpen: false,
    options: null,
    resolve: null,
  });

  // Use a ref so handleClose always has the latest resolve without re-creating the callback
  const resolveRef = useRef<((value: boolean) => void) | null>(null);
  resolveRef.current = state.resolve;

  const showDialog = useCallback((options: DialogOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setState({
        isOpen: true,
        options,
        resolve,
      });
    });
  }, []);

  const handleClose = useCallback((result: boolean) => {
    resolveRef.current?.(result);
    setState({
      isOpen: false,
      options: null,
      resolve: null,
    });
  }, []);

  const confirm = useCallback((options: DialogOptions) => {
    return showDialog({ ...options, type: "confirm" });
  }, [showDialog]);

  const alert = useCallback((options: Omit<DialogOptions, "cancelLabel">) => {
    return showDialog({ ...options, type: options.type || "info" }).then(() => {});
  }, [showDialog]);

  const danger = useCallback((options: DialogOptions) => {
    return showDialog({ ...options, type: "danger" });
  }, [showDialog]);

  return (
    <DialogContext.Provider value={{ confirm, alert, danger, isOpen: state.isOpen }}>
      {children}
      <Dialog state={state} onClose={handleClose} />
    </DialogContext.Provider>
  );
}
