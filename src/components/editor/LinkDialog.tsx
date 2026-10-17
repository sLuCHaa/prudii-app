import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { X, ExternalLink, Link2, Unlink, AlertTriangle, Type } from "lucide-react";
import i18n from "../../lib/i18n";
import { checkLink } from "../../lib/linkChecker";
import { normalizeLinkInput } from "./linkInput";
import { Button } from "../ui/Button";

export function LinkDialog({
  isOpen,
  onClose,
  onSubmit,
  onRemove,
  initialUrl,
  hasExistingLink,
  askText = false,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (url: string, text: string) => void;
  onRemove: () => void;
  initialUrl: string;
  hasExistingLink: boolean;
  /** Nothing is selected, so the link needs its own text. */
  askText?: boolean;
}) {
  const [url, setUrl] = useState(initialUrl);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setUrl(initialUrl);
      setText("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialUrl]);

  const result = normalizeLinkInput(url);
  const problem = !result.ok && result.reason !== "empty" ? result.reason : null;
  const warnings = result.ok && /^https?:/i.test(result.href) ? checkLink(result.href).warnings : [];

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!result.ok) return;
    onSubmit(result.href, askText ? text : "");
    onClose();
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-60 flex items-center justify-center modal-backdrop">
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="bg-surface rounded-xl shadow-lg w-full max-w-md overflow-hidden"
      >
        <form onSubmit={handleSubmit}>
          <div className="px-4 py-3 border-b border-border bg-bg-secondary flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Link2 className="w-4 h-4 text-accent" />
              <h3 className="text-sm font-semibold text-text">
                {hasExistingLink ? i18n.t("compose.linkEdit") : i18n.t("compose.linkInsert")}
              </h3>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded hover:bg-hover transition-colors text-text-tertiary"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="p-4">
            <label className="block text-xs font-medium text-text-secondary mb-2">
              URL
            </label>
            <div className="relative">
              <ExternalLink className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
              <input
                ref={inputRef}
                type="text"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com"
                spellCheck={false}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                aria-invalid={!!problem}
                aria-describedby={problem || warnings.length > 0 ? "link-dialog-hint" : undefined}
                className={`w-full pl-10 pr-4 py-2.5 rounded-control inset-shadow-field border bg-bg-secondary text-sm text-text placeholder:text-text-secondary focus:ring-1 ${problem ? "border-danger focus:border-danger focus:ring-danger" : "border-border focus:border-accent focus:ring-accent"}`}
              />
            </div>
            {problem && (
              <p id="link-dialog-hint" className="mt-2 text-xs text-danger">
                {i18n.t(`compose.linkErrors.${problem}`)}
              </p>
            )}
            {!problem && warnings.length > 0 && (
              <div id="link-dialog-hint" className="mt-2 flex gap-2 rounded-lg bg-warning/10 px-3 py-2 text-xs text-text-secondary">
                <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0 text-warning" />
                <div className="min-w-0">
                  <p className="font-medium text-text">{i18n.t("linkCheck.suspiciousLink")}</p>
                  <p>{warnings.map((w) => i18n.t(`linkCheck.${w.type}`)).join(" · ")}</p>
                </div>
              </div>
            )}
            {askText && (
              <>
                <label htmlFor="link-dialog-text" className="block text-xs font-medium text-text-secondary mt-4 mb-2">
                  {i18n.t("compose.linkText")}
                </label>
                <div className="relative">
                  <Type className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-text-tertiary" />
                  <input
                    id="link-dialog-text"
                    type="text"
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder={i18n.t("compose.linkTextPlaceholder")}
                    autoComplete="off"
                    className="w-full pl-10 pr-4 py-2.5 rounded-control inset-shadow-field border border-border bg-bg-secondary text-sm text-text placeholder:text-text-secondary focus:border-accent focus:ring-1 focus:ring-accent"
                  />
                </div>
              </>
            )}
          </div>

          <div className="px-4 py-3 border-t border-border bg-bg-secondary flex items-center justify-between">
            {hasExistingLink ? (
              <button
                type="button"
                onClick={() => {
                  onRemove();
                  onClose();
                }}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm text-danger hover:bg-danger/10 transition-colors"
              >
                <Unlink className="w-4 h-4" />
                {i18n.t("compose.linkRemove")}
              </button>
            ) : (
              <div />
            )}
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 rounded-lg text-sm text-text-secondary hover:bg-hover transition-colors"
              >
                {i18n.t("common.cancel")}
              </button>
              <Button
                size="sm"
                type="submit"
                disabled={!result.ok}
              >
                {hasExistingLink ? i18n.t("compose.linkUpdate") : i18n.t("compose.linkInsertBtn")}
              </Button>
            </div>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
