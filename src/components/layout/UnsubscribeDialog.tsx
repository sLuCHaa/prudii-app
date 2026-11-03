import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { MailMinus, UserMinus } from "../icons";
import { useFocusTrap } from "../../hooks/useFocusTrap";
import { Button } from "../ui/Button";
import { Switch } from "../ui/Switch";

interface UnsubscribeDialogProps {
  mode: "unsubscribe" | "block";
  name: string;
  address: string;
  onConfirm: (trashExisting: boolean) => void;
  onCancel: () => void;
}

export function UnsubscribeDialog({ mode, name, address, onConfirm, onCancel }: UnsubscribeDialogProps) {
  const { t } = useTranslation();
  const [trashExisting, setTrashExisting] = useState(true);
  const trapRef = useFocusTrap<HTMLDivElement>(true);
  const block = mode === "block";
  const Icon = block ? UserMinus : MailMinus;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onCancel]);

  return createPortal(
    <div className="fixed inset-0 modal-backdrop flex items-center justify-center z-100" onClick={(e) => e.target === e.currentTarget && onCancel()}>
      <div
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsubscribe-dialog-title"
        className="bg-surface rounded-xl shadow-2xl inset-shadow-edge w-full max-w-sm mx-4 overflow-hidden modal-panel-enter"
      >
        <div className="p-6 flex items-start gap-4">
          <div className="p-3 rounded-full bg-accent/10 text-accent shrink-0">
            <Icon className="w-6 h-6" />
          </div>
          <div className="flex-1 min-w-0 pt-1">
            <h3 id="unsubscribe-dialog-title" className="text-lg font-semibold text-text mb-2 break-words">
              {t(block ? "unsubscribe.blockDialogTitle" : "unsubscribe.dialogTitle", { name })}
            </h3>
            <p className="text-sm text-text-secondary leading-relaxed">
              {block ? t("unsubscribe.blockDialogMessage", { address }) : t("unsubscribe.dialogMessage")}
            </p>
            <label htmlFor="unsubscribe-trash-existing" className="mt-4 flex items-center justify-between gap-3 text-sm text-text cursor-pointer">
              <span>{t("unsubscribe.trashExisting")}</span>
              <Switch id="unsubscribe-trash-existing" checked={trashExisting} onChange={setTrashExisting} />
            </label>
          </div>
        </div>
        <div className="flex gap-3 p-4 pt-0">
          <Button variant="secondary" fullWidth onClick={onCancel}>
            {t("dialog.cancel")}
          </Button>
          <Button variant="primary" fullWidth onClick={() => onConfirm(trashExisting)}>
            {t(block ? "unsubscribe.confirmBlock" : "unsubscribe.confirm")}
          </Button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
