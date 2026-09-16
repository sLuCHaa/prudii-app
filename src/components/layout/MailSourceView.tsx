import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, ChevronRight, Copy, Loader2 } from "lucide-react";
import { fetchMailSource } from "../../lib/tauri";
import { splitMailSource, foldedBytes } from "../../lib/mailSource";
import { formatFileSize } from "../../lib/fileSize";

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; source: string };

/**
 * The message exactly as the server holds it.
 *
 * The source is fetched per view and never cached: it is several times the size
 * of the parsed body once attachments are counted. Payload runs start folded —
 * see lib/mailSource — because a mail with one PDF is otherwise megabytes of
 * base64 with the part headers lost somewhere inside it.
 */
export function MailSourceView({ mailId }: { mailId: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<State>({ status: "loading" });
  const [showAll, setShowAll] = useState(false);
  const [opened, setOpened] = useState<ReadonlySet<number>>(new Set());
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    setShowAll(false);
    setOpened(new Set());
    fetchMailSource(mailId)
      .then((source) => { if (!cancelled) setState({ status: "ready", source }); })
      .catch((err) => { if (!cancelled) setState({ status: "error", message: err instanceof Error ? err.message : String(err) }); });
    return () => { cancelled = true; };
  }, [mailId]);

  const source = state.status === "ready" ? state.source : "";
  const segments = useMemo(() => splitMailSource(source), [source]);
  const folded = useMemo(() => foldedBytes(segments), [segments]);

  async function handleCopy() {
    await writeText(source);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  if (state.status === "loading") {
    return (
      <div className="flex items-center gap-2 py-8 justify-center text-xs text-text-tertiary">
        <Loader2 className="w-4 h-4 animate-spin" />
        {t("mailDetail.source.loading")}
      </div>
    );
  }

  if (state.status === "error") {
    return (
      <div className="px-4 py-3 rounded-lg border border-danger/40 bg-danger/5 text-xs text-text-secondary">
        <div className="font-medium text-text mb-1">{t("mailDetail.source.error")}</div>
        <div className="select-text break-words">{state.message}</div>
      </div>
    );
  }

  return (
    <div>
      <div className="flex items-center gap-2 mb-2">
        <button
          onClick={handleCopy}
          className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-text-tertiary hover:text-text-secondary hover:bg-hover transition-colors"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? t("mailDetail.source.copied") : t("mailDetail.source.copy")}
        </button>
        {folded > 0 && (
          <button
            onClick={() => setShowAll((v) => !v)}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium text-text-tertiary hover:text-text-secondary hover:bg-hover transition-colors"
          >
            {showAll ? t("mailDetail.source.collapseAll") : t("mailDetail.source.showAll", { size: formatFileSize(folded) })}
          </button>
        )}
      </div>

      <pre className="text-[11.5px] leading-[1.55] font-mono whitespace-pre-wrap break-all select-text text-text-secondary">
        {segments.map((seg, i) => {
          if (seg.kind === "text") return <span key={i}>{seg.text}{"\n"}</span>;
          if (showAll || opened.has(i)) return <span key={i} className="text-text-tertiary">{seg.text}{"\n"}</span>;
          return (
            <button
              key={i}
              onClick={() => setOpened((prev) => new Set(prev).add(i))}
              className="my-1 inline-flex items-center gap-1.5 px-2 py-1 rounded border border-border bg-bg-secondary text-[11px] font-sans text-text-tertiary hover:text-text-secondary hover:bg-hover transition-colors"
            >
              <ChevronRight className="w-3 h-3" />
              {t("mailDetail.source.folded", { lines: seg.lines, size: formatFileSize(seg.bytes) })}
            </button>
          );
        })}
      </pre>
    </div>
  );
}
