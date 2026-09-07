import { useState, useEffect, useRef } from "react";
import { motion } from "motion/react";
import { X, ExternalLink, Link2, Unlink } from "lucide-react";
import i18n from "../../lib/i18n";

export function LinkDialog({
  isOpen,
  onClose,
  onSubmit,
  onRemove,
  initialUrl,
  hasExistingLink,
}: {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (url: string) => void;
  onRemove: () => void;
  initialUrl: string;
  hasExistingLink: boolean;
}) {
  const [url, setUrl] = useState(initialUrl);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (isOpen) {
      setUrl(initialUrl);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen, initialUrl]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (url.trim()) {
      let finalUrl = url.trim();
      if (!/^https?:\/\//i.test(finalUrl)) {
        finalUrl = "https://" + finalUrl;
      }
      onSubmit(finalUrl);
    }
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
                className="w-full pl-10 pr-4 py-2.5 rounded-lg border border-border bg-bg-secondary text-sm text-text placeholder:text-text-secondary focus:border-accent focus:ring-1 focus:ring-accent"
              />
            </div>
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
              <button
                type="submit"
                disabled={!url.trim()}
                className="px-4 py-1.5 rounded-lg text-sm font-medium bg-accent text-white hover:bg-accent-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {hasExistingLink ? i18n.t("compose.linkUpdate") : i18n.t("compose.linkInsertBtn")}
              </button>
            </div>
          </div>
        </form>
      </motion.div>
    </div>
  );
}
